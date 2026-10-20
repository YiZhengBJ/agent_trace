use anyhow::{bail, Context, Result};
use fs2::FileExt;
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Config {
    pub port: u16,
}
impl Default for Config {
    fn default() -> Self {
        Self { port: 4317 }
    }
}
#[derive(Clone, Debug)]
pub struct Runtime {
    pub home: PathBuf,
    pub config: Config,
    pub runtime_dir: Option<PathBuf>,
}
#[derive(Serialize, Deserialize)]
struct Instance {
    pid: u32,
    port: u16,
    instance_id: String,
}
pub fn private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
pub fn default_home() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("trace-gateway")
}
impl Runtime {
    pub fn load(
        home: Option<PathBuf>,
        port: Option<u16>,
        runtime_dir: Option<PathBuf>,
    ) -> Result<Self> {
        let home = home.unwrap_or_else(default_home);
        let home = if home.is_absolute() {
            home
        } else {
            std::env::current_dir()?.join(home)
        };
        let config_path = home.join("config.json");
        let mut config = if config_path.exists() {
            serde_json::from_slice(&fs::read(config_path)?)?
        } else {
            Config::default()
        };
        if let Some(port) = port {
            if port == 0 {
                bail!("Port must be between 1 and 65535");
            }
            config.port = port;
        }
        Ok(Self {
            home,
            config,
            runtime_dir,
        })
    }
    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.config.port)
    }
    pub fn client(&self) -> Result<Client> {
        Ok(Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(5))
            .build()?)
    }
    pub fn init(&self) -> Result<()> {
        fs::create_dir_all(&self.home)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.home, fs::Permissions::from_mode(0o700))?;
        }
        private_write(
            &self.home.join("config.json"),
            &serde_json::to_vec_pretty(&self.config)?,
        )?;
        let token = self.home.join("control.token");
        if !token.exists() {
            private_write(&token, uuid::Uuid::new_v4().to_string().as_bytes())?;
        }
        Ok(())
    }
    fn identity(&self) -> Result<Instance> {
        Ok(serde_json::from_slice(&fs::read(
            self.home.join("instance.json"),
        )?)?)
    }
    pub fn running(&self) -> bool {
        let Ok(instance) = self.identity() else {
            return false;
        };
        if instance.port != self.config.port {
            return false;
        }
        let Ok(client) = self.client() else {
            return false;
        };
        let Ok(response) = client.get(format!("{}/api/health", self.base())).send() else {
            return false;
        };
        let Ok(v) = response.json::<Value>() else {
            return false;
        };
        v["app"] == "trace-gateway" && v["instanceId"] == instance.instance_id
    }
    pub fn get(&self, endpoint: &str) -> Result<Value> {
        if !self.running() {
            bail!("Gateway is not running for this data directory. Run: trace start (or choose --port to avoid an existing gateway).");
        }
        let response = self
            .client()?
            .get(format!("{}{}", self.base(), endpoint))
            .send()?;
        let status = response.status();
        let v = response.json::<Value>()?;
        if !status.is_success() {
            bail!("Gateway HTTP {status}: {v}");
        }
        Ok(v)
    }
    pub fn send(&self, method: &str, endpoint: &str, data: Value, admin: bool) -> Result<Value> {
        if !self.running() {
            bail!("Gateway is not running. Run trace start first.");
        }
        let mut req = self
            .client()?
            .request(method.parse()?, format!("{}{}", self.base(), endpoint));
        if admin {
            req = req.header(
                "x-trace-control-token",
                fs::read_to_string(self.home.join("control.token"))?,
            );
        }
        let response = req.json(&data).send()?;
        let status = response.status();
        let v = response.json::<Value>()?;
        if !status.is_success() {
            bail!("Gateway HTTP {status}: {v}");
        }
        Ok(v)
    }
    pub fn node_path(&self) -> Result<PathBuf> {
        let exe = std::env::current_exe()?;
        let parent = exe.parent().context("Executable has no parent")?;
        let name = if cfg!(windows) { "node.exe" } else { "node" };
        let mut candidates = vec![];
        if let Some(root) = &self.runtime_dir {
            candidates.push(root.join(name));
        }
        if let Some(root) = std::env::var_os("TRACE_RUNTIME_DIR") {
            candidates.push(PathBuf::from(root).join(name));
        }
        candidates.push(parent.join("runtime").join(name));
        candidates.push(parent.join("../Resources/runtime").join(name));
        #[cfg(target_os = "linux")]
        {
            for product in ["trace-gateway-desktop", "trace-desktop", "Trace Gateway"] {
                candidates.push(
                    parent
                        .join("../lib")
                        .join(product)
                        .join("runtime")
                        .join(name),
                );
                if let Some(appdir) = std::env::var_os("APPDIR") {
                    candidates.push(
                        PathBuf::from(appdir)
                            .join("usr/lib")
                            .join(product)
                            .join("runtime")
                            .join(name),
                    );
                }
            }
        }
        candidates.push(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../runtime")
                .join(name),
        );
        candidates.into_iter().find(|p|p.is_file()).context("Bundled runtime missing. Unpack the complete distribution, or pass --runtime-dir <directory containing node>.")
    }
    fn extract_engine(&self) -> Result<PathBuf> {
        let root = self.home.join("engine").join(VERSION);
        for (name, data) in [
            (
                "server.mjs",
                include_bytes!("../../../gateway/server.mjs").as_slice(),
            ),
            (
                "redaction.mjs",
                include_bytes!("../../../gateway/redaction.mjs").as_slice(),
            ),
            (
                "session-matcher.mjs",
                include_bytes!("../../../gateway/session-matcher.mjs").as_slice(),
            ),
            (
                "public/index.html",
                include_bytes!("../../../gateway/public/index.html").as_slice(),
            ),
            (
                "public/app.js",
                include_bytes!("../../../gateway/public/app.js").as_slice(),
            ),
            (
                "public/style.css",
                include_bytes!("../../../gateway/public/style.css").as_slice(),
            ),
        ] {
            private_write(&root.join(name), data)?;
        }
        Ok(root.join("server.mjs"))
    }
    pub fn start(&self) -> Result<Value> {
        if self.running() {
            return Ok(json!({"running":true,"url":self.base(),"alreadyRunning":true}));
        }
        let address: SocketAddr = format!("127.0.0.1:{}", self.config.port).parse()?;
        if TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok() {
            bail!("Port {} is already in use by another process. Choose --port <free-port>; the existing gateway will not be interrupted.",self.config.port);
        }
        self.node_path()?;
        self.init()?;
        let log = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.home.join("gateway.log"))?;
        let executable = std::env::current_exe()?;
        let cli = if executable.file_stem().is_some_and(|x| x == "trace-desktop") {
            executable
                .parent()
                .context("No app directory")?
                .join(if cfg!(windows) { "trace.exe" } else { "trace" })
        } else {
            executable
        };
        let mut cmd = Command::new(cli);
        cmd.arg("--home")
            .arg(&self.home)
            .arg("--port")
            .arg(self.config.port.to_string());
        if let Some(dir) = &self.runtime_dir {
            cmd.arg("--runtime-dir").arg(dir);
        }
        cmd.arg("serve")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone()?))
            .stderr(Stdio::from(log));
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000 | 0x00000200);
        }
        let mut child = cmd.spawn()?;
        for _ in 0..120 {
            if self.running() {
                return Ok(json!({"running":true,"url":self.base()}));
            }
            if let Some(status) = child.try_wait()? {
                bail!(
                    "Gateway exited ({status}); see {}",
                    self.home.join("gateway.log").display()
                );
            }
            thread::sleep(Duration::from_millis(100));
        }
        bail!(
            "Gateway did not become ready; see {}",
            self.home.join("gateway.log").display()
        )
    }
    fn daemon_idle(&self) -> bool {
        let path = self.home.join("daemon.lock");
        if !path.exists() {
            return true;
        }
        let Ok(file) = OpenOptions::new().read(true).write(true).open(path) else {
            return false;
        };
        file.try_lock_exclusive().is_ok()
    }
    pub fn stop(&self) -> Result<Value> {
        if self.running() {
            self.send("POST", "/api/admin/shutdown", json!({}), true)?;
        }
        for _ in 0..100 {
            if !self.running() && self.daemon_idle() {
                return Ok(json!({"running":false}));
            }
            thread::sleep(Duration::from_millis(100));
        }
        bail!("Gateway is still stopping; check gateway.log.")
    }
    pub fn serve(&self) -> Result<()> {
        self.init()?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.home.join("daemon.lock"))?;
        lock.try_lock_exclusive()
            .context("Gateway is already running for this data directory")?;
        let engine = self.extract_engine()?;
        let id = uuid::Uuid::new_v4().to_string();
        let token = fs::read_to_string(self.home.join("control.token"))?;
        private_write(
            &self.home.join("instance.json"),
            &serde_json::to_vec(&Instance {
                pid: std::process::id(),
                port: self.config.port,
                instance_id: id.clone(),
            })?,
        )?;
        let interrupted = Arc::new(AtomicBool::new(false));
        let flag = interrupted.clone();
        ctrlc::set_handler(move || {
            flag.store(true, Ordering::SeqCst);
        })?;
        let mut cmd = Command::new(self.node_path()?);
        cmd.stdin(Stdio::piped());
        cmd.arg(engine)
            .env("TRACE_PARENT_WATCH", "1")
            .env("PORT", self.config.port.to_string())
            .env("DATA_DIR", self.home.join("data"))
            .env("TRACE_CONTROL_TOKEN", token.trim())
            .env("TRACE_INSTANCE_ID", id)
            .env("TRACE_SEED_DEMO", "0");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
        }
        let mut child = cmd.spawn()?;
        println!("Trace Gateway {} — {}", VERSION, self.base());
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            if interrupted.swap(false, Ordering::SeqCst) {
                let _ = self.send("POST", "/api/admin/shutdown", json!({}), true);
            }
            thread::sleep(Duration::from_millis(100));
        };
        let _ = fs::remove_file(self.home.join("instance.json"));
        FileExt::unlock(&lock)?;
        if !status.success() {
            bail!("Gateway engine exited: {status}");
        }
        Ok(())
    }
    pub fn provider(&self, name: &str) -> Result<Value> {
        let state = self.get("/api/state")?;
        let found = state["providers"]
            .as_array()
            .context("Invalid state")?
            .iter()
            .find(|p| p["id"] == name || p["name"] == name)
            .cloned();
        found.with_context(|| format!("Provider not found: {name}"))
    }
    pub fn import_data(&self, source: &Path) -> Result<Value> {
        if self.running() {
            bail!("Stop this gateway before importing data.");
        }
        let dest = self.home.join("data");
        fn has_files(path: &Path) -> Result<bool> {
            if !path.exists() {
                return Ok(false);
            }
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                let kind = entry.file_type()?;
                if !kind.is_dir() || has_files(&entry.path())? {
                    return Ok(true);
                }
            }
            Ok(false)
        }
        if has_files(&dest)? {
            bail!("Destination data directory must be empty; existing records will not be overwritten.");
        }
        if !source.join("providers.json").is_file() {
            bail!("Source must contain providers.json and records/");
        }
        fs::create_dir_all(dest.join("records"))?;
        for name in ["providers.json", "settings.json"] {
            if source.join(name).is_file() {
                private_write(&dest.join(name), &fs::read(source.join(name))?)?;
            }
        }
        let mut count = 0;
        for entry in fs::read_dir(source.join("records"))? {
            let entry = entry?;
            if entry.path().extension().is_some_and(|x| x == "json") {
                private_write(
                    &dest.join("records").join(entry.file_name()),
                    &fs::read(entry.path())?,
                )?;
                count += 1;
            }
        }
        Ok(
            json!({"importedRecords":count,"destination":dest,"note":"Credentials are scrubbed by the gateway on its next startup."}),
        )
    }
}
pub fn open_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    let mut cmd = Command::new("open");
    #[cfg(target_os = "linux")]
    let mut cmd = Command::new("xdg-open");
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    cmd.arg(url);
    cmd.spawn()
        .context("Cannot open browser; open the printed URL manually")?;
    Ok(())
}

pub fn lock_desktop(home: &Path) -> Result<std::fs::File> {
    fs::create_dir_all(home)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(home.join("desktop.lock"))?;
    file.try_lock_exclusive()
        .context("Tray application is already running")?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_default_and_invalid_ports() {
        assert_eq!(Config::default().port, 4317);
        assert!(serde_json::from_value::<Config>(json!({"port":70000})).is_err());
        assert!(Runtime::load(None, Some(0), None).is_err());
    }
}
