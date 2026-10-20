#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{path::PathBuf, process::Command, thread};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WebviewUrl, WebviewWindowBuilder,
};
use trace_runtime::Runtime;
fn open_window(app: &tauri::AppHandle, runtime: &Runtime) {
    if !runtime.running() {
        eprintln!("Gateway is not running; use the tray Start menu first.");
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Ok(url) = runtime.base().parse() else {
        return;
    };
    let _ = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("Trace Gateway")
        .inner_size(1440.0, 950.0)
        .min_inner_size(720.0, 500.0)
        .build();
}
fn service_action(runtime: &Runtime, action: &str) {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(parent) = exe.parent() else {
        return;
    };
    let cli = parent.join(if cfg!(windows) { "trace.exe" } else { "trace" });
    let mut cmd = Command::new(cli);
    cmd.arg("--home")
        .arg(&runtime.home)
        .arg("--port")
        .arg(runtime.config.port.to_string())
        .args(["service", action, "--desktop"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    match cmd.output() {
        Ok(result) if result.status.success() => {}
        Ok(result) => eprintln!("Login startup: {}", String::from_utf8_lossy(&result.stderr)),
        Err(error) => eprintln!("Login startup: {error}"),
    }
}
fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let home = arguments
        .windows(2)
        .find(|a| a[0] == "--home")
        .map(|a| PathBuf::from(&a[1]))
        .or_else(|| std::env::var_os("TRACE_HOME").map(PathBuf::from))
        .unwrap_or_else(trace_runtime::default_home);
    let _desktop_lock = match trace_runtime::lock_desktop(&home) {
        Ok(lock) => lock,
        Err(error) => {
            eprintln!("{error:#}");
            return;
        }
    };
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            let arguments: Vec<String> = std::env::args().collect();
            let home = arguments
                .windows(2)
                .find(|a| a[0] == "--home")
                .map(|a| PathBuf::from(&a[1]))
                .or_else(|| std::env::var_os("TRACE_HOME").map(PathBuf::from));
            let port = arguments
                .windows(2)
                .find(|a| a[0] == "--port")
                .and_then(|a| a[1].parse().ok());
            let runtime_dir = app.path().resource_dir()?.join("runtime");
            let mut runtime = Runtime::load(home, port, Some(runtime_dir))?;
            // A first desktop launch may coexist with the browser prototype.
            if port.is_none() && !runtime.home.join("config.json").exists() {
                for candidate in 4317..=4327 {
                    if let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", candidate)) {
                        drop(listener);
                        runtime.config.port = candidate;
                        break;
                    }
                }
            }
            let status = MenuItem::with_id(app, "status", "网关启动中…", false, None::<&str>)?;
            let open = MenuItem::with_id(app, "open", "打开轨迹控制台", true, None::<&str>)?;
            let browser = MenuItem::with_id(app, "browser", "在浏览器中打开", true, None::<&str>)?;
            let start = MenuItem::with_id(app, "start", "启动网关", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "停止网关", true, None::<&str>)?;
            let autostart =
                MenuItem::with_id(app, "autostart", "启用登录时启动托盘", true, None::<&str>)?;
            let noautostart =
                MenuItem::with_id(app, "noautostart", "取消登录时启动托盘", true, None::<&str>)?;
            let quit =
                MenuItem::with_id(app, "quit", "退出托盘（网关继续运行）", true, None::<&str>)?;
            let shutdown =
                MenuItem::with_id(app, "shutdown", "停止网关并退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &status,
                    &open,
                    &browser,
                    &start,
                    &stop,
                    &autostart,
                    &noautostart,
                    &quit,
                    &shutdown,
                ],
            )?;
            let menu_runtime = runtime.clone();
            let menu_status = status.clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("bundled icon").clone())
                .tooltip("Trace Gateway")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| {
                    let runtime = menu_runtime.clone();
                    let status = menu_status.clone();
                    match event.id.as_ref() {
                        "open" => open_window(app, &runtime),
                        "browser" => {
                            if runtime.running() {
                                let _ = trace_runtime::open_browser(&runtime.base());
                            }
                        }
                        "start" => {
                            thread::spawn(move || match runtime.start() {
                                Ok(_) => {
                                    let _ = status
                                        .set_text(format!("网关运行中 · {}", runtime.config.port));
                                }
                                Err(e) => {
                                    let _ = status.set_text("网关启动失败（检查端口/日志）");
                                    eprintln!("{e:#}");
                                }
                            });
                        }
                        "stop" => {
                            thread::spawn(move || match runtime.stop() {
                                Ok(_) => {
                                    let _ = status.set_text("网关已停止");
                                }
                                Err(e) => eprintln!("{e:#}"),
                            });
                        }
                        "autostart" => {
                            thread::spawn(move || service_action(&runtime, "install"));
                        }
                        "noautostart" => {
                            thread::spawn(move || service_action(&runtime, "uninstall"));
                        }
                        "quit" => app.exit(0),
                        "shutdown" => {
                            let handle = app.clone();
                            thread::spawn(move || {
                                let _ = runtime.stop();
                                handle.exit(0);
                            });
                        }
                        _ => {}
                    }
                })
                .build(app)?;
            thread::spawn(move || match runtime.start() {
                Ok(_) => {
                    let _ = status.set_text(format!("网关运行中 · {}", runtime.config.port));
                }
                Err(e) => {
                    let _ = status.set_text("网关启动失败（检查端口/日志）");
                    eprintln!("{e:#}");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("Trace Gateway desktop initialization failed")
        .run(|_, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
}
