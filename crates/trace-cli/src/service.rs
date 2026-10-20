use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, process::Command};
use trace_runtime::{private_write, Runtime};
fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
#[cfg(target_os = "linux")]
fn quoted(s: &str) -> String {
    format!(
        "\"{}\"",
        s.replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%")
    )
}
fn invoke(cmd: &str, args: &[&str]) -> Result<()> {
    let output = Command::new(cmd)
        .args(args)
        .output()
        .with_context(|| format!("Cannot execute {cmd}"))?;
    if !output.status.success() {
        bail!("{cmd} failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    Ok(())
}
pub fn manage(runtime: &Runtime, action: &str, dry_run: bool, desktop: bool) -> Result<Value> {
    let executable = std::env::current_exe()?;
    let daemon_args = vec![
        "--home".to_string(),
        runtime.home.to_string_lossy().into_owned(),
        "--port".to_string(),
        runtime.config.port.to_string(),
        "serve".to_string(),
    ];
    let desktop_exe = executable
        .parent()
        .context("No executable directory")?
        .join(if cfg!(windows) {
            "trace-desktop.exe"
        } else {
            "trace-desktop"
        });
    if desktop && !desktop_exe.is_file() {
        bail!(
            "Desktop executable not found alongside CLI: {}",
            desktop_exe.display()
        );
    }
    let binary = if desktop {
        desktop_exe
    } else if cfg!(windows) {
        let helper = executable.with_file_name("trace-background.exe");
        if !helper.is_file() {
            bail!("Missing headless helper: {}", helper.display());
        }
        helper
    } else {
        executable
    };
    let args = if desktop {
        daemon_args[..daemon_args.len() - 1].to_vec()
    } else {
        daemon_args
    };
    let user_home = dirs::home_dir().context("No user home")?;
    let (target, content): (PathBuf, String);
    #[cfg(target_os = "macos")]
    {
        target = user_home.join("Library/LaunchAgents/dev.trace.gateway.plist");
        content=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict><key>Label</key><string>dev.trace.gateway</string><key>ProgramArguments</key><array><string>{}</string>{}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer><key>EnvironmentVariables</key><dict><key>TRACE_HOME</key><string>{}</string></dict><key>StandardOutPath</key><string>{}</string><key>StandardErrorPath</key><string>{}</string></dict></plist>",xml(&binary.to_string_lossy()),args.iter().map(|a|format!("<string>{}</string>",xml(a))).collect::<String>(),xml(&runtime.home.to_string_lossy()),xml(&runtime.home.join("service.log").to_string_lossy()),xml(&runtime.home.join("service.log").to_string_lossy()));
    }
    #[cfg(target_os = "linux")]
    {
        target = if desktop {
            user_home.join(".config/autostart/trace-gateway.desktop")
        } else {
            user_home.join(".config/systemd/user/trace-gateway.service")
        };
        let command = format!(
            "{} {}",
            quoted(&binary.to_string_lossy()),
            args.iter().map(|a| quoted(a)).collect::<Vec<_>>().join(" ")
        );
        content = if desktop {
            format!("[Desktop Entry]\nType=Application\nName=Trace Gateway\nExec={command}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n")
        } else {
            format!("[Unit]\nDescription=Trace Gateway (headless)\nAfter=network.target\n[Service]\nType=simple\nExecStart={command}\nRestart=on-failure\nRestartSec=3\n[Install]\nWantedBy=default.target\n")
        };
    }
    #[cfg(windows)]
    {
        let _ = user_home;
        target = runtime.home.join("trace-gateway-task.xml");
        let user = format!(
            "{}\\{}",
            std::env::var("USERDOMAIN").unwrap_or_default(),
            std::env::var("USERNAME").unwrap_or_default()
        );
        let arguments = args
            .iter()
            .map(|a| format!("\"{}\"", a.replace('"', "\\\"")))
            .collect::<Vec<_>>()
            .join(" ");
        content=format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\"><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{}</UserId></LogonTrigger></Triggers><Principals><Principal id=\"Author\"><UserId>{}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context=\"Author\"><Exec><Command>{}</Command><Arguments>{}</Arguments></Exec></Actions></Task>",xml(&user),xml(&user),xml(&binary.to_string_lossy()),xml(&arguments));
    }
    if dry_run {
        return Ok(
            json!({"action":action,"desktop":desktop,"path":target,"configuration":content,"dryRun":true}),
        );
    }
    runtime.init()?;
    if action == "install" {
        if !desktop && runtime.running() {
            runtime.stop()?;
        }
        private_write(&target, content.as_bytes())?;
        #[cfg(target_os = "macos")]
        {
            let uid = String::from_utf8(Command::new("id").arg("-u").output()?.stdout)?
                .trim()
                .to_string();
            let domain = format!("gui/{uid}");
            let label = format!("{domain}/dev.trace.gateway");
            let _ = Command::new("launchctl").args(["bootout", &label]).output();
            invoke(
                "launchctl",
                &["bootstrap", &domain, &target.to_string_lossy()],
            )?;
        }
        #[cfg(target_os = "linux")]
        {
            if !desktop {
                invoke("systemctl", &["--user", "daemon-reload"])?;
                invoke(
                    "systemctl",
                    &["--user", "enable", "--now", "trace-gateway.service"],
                )?;
            }
        }
        #[cfg(windows)]
        {
            invoke(
                "schtasks.exe",
                &[
                    "/Create",
                    "/TN",
                    "TraceGateway",
                    "/XML",
                    &target.to_string_lossy(),
                    "/F",
                ],
            )?;
            invoke("schtasks.exe", &["/Run", "/TN", "TraceGateway"])?;
        }
    } else if action == "uninstall" {
        #[cfg(target_os = "macos")]
        {
            let uid = String::from_utf8(Command::new("id").arg("-u").output()?.stdout)?
                .trim()
                .to_string();
            invoke(
                "launchctl",
                &["bootout", &format!("gui/{uid}/dev.trace.gateway")],
            )?;
        }
        #[cfg(target_os = "linux")]
        {
            if !desktop {
                invoke(
                    "systemctl",
                    &["--user", "disable", "--now", "trace-gateway.service"],
                )?;
            }
        }
        #[cfg(windows)]
        {
            invoke("schtasks.exe", &["/Delete", "/TN", "TraceGateway", "/F"])?;
        }
        if target.exists() {
            fs::remove_file(&target)?;
        }
    } else if action == "status" {
        return Ok(
            json!({"installed":target.exists(),"path":target,"running":runtime.running(),"desktop":desktop}),
        );
    } else {
        bail!("Unknown service action: {action}");
    }
    Ok(json!({"action":action,"path":target,"desktop":desktop}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_configuration_escapes_user_paths() {
        assert_eq!(xml("a&<b>\"'"), "a&amp;&lt;b&gt;&quot;&apos;");
    }
}
