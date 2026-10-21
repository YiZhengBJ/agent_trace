mod service;
use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};
use trace_runtime::{Runtime, VERSION};
#[derive(Parser)]
#[command(
    name = "trace",
    version,
    about = "Local agent trajectory gateway — headless service and CLI"
)]
struct Args {
    #[arg(long, global = true, env = "TRACE_HOME")]
    home: Option<PathBuf>,
    #[arg(long, global = true)]
    port: Option<u16>,
    #[arg(long, global = true, env = "TRACE_RUNTIME_DIR")]
    runtime_dir: Option<PathBuf>,
    #[arg(long, global = true)]
    json: bool,
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand)]
enum Commands {
    /// Start a detached gateway (no desktop required)
    Start,
    /// Run in the foreground; suitable for systemd, launchd, containers
    Serve,
    /// Stop only the gateway owned by this data directory
    Stop,
    /// Restart the gateway
    Restart,
    /// Show gateway status and effective data directory
    Status,
    /// Open the web console in a browser
    Open,
    /// Manage upstream providers
    Provider {
        #[command(subcommand)]
        command: Provider,
    },
    /// Inspect recorded sessions
    Session {
        #[command(subcommand)]
        command: Session,
    },
    /// Enable, disable or inspect pre-tool file backups
    Backup {
        #[command(subcommand)]
        command: Backup,
    },
    /// Install or remove login/background persistence
    Service {
        #[arg(value_parser=["install","uninstall","status"])]
        action: String,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        desktop: bool,
    },
    /// Import a previous gateway's data (destination must be empty and stopped)
    Import {
        #[arg(long)]
        from: PathBuf,
    },
    /// Show config and runtime locations
    Config,
}
#[derive(Subcommand)]
enum Backup {
    /// Enable backups; takes effect for subsequent requests without restart
    Enable,
    /// Disable backups without deleting existing snapshots
    Disable,
    /// Show the persisted switch and effective configuration file
    Status,
}
#[derive(Subcommand)]
enum Provider {
    List,
    /// Show the currently selected default provider
    Current,
    Add {
        #[arg(long)]
        name: String,
        #[arg(long)]
        url: String,
        #[arg(long,default_value="auto",value_parser=["auto","openai","anthropic"])]
        protocol: String,
        #[arg(long)]
        activate: bool,
    },
    /// Select default provider by ID or exact name
    Use {
        id: String,
    },
    /// Print Harness base URLs
    Url {
        id: Option<String>,
    },
    /// Remove provider configuration, keeping its trajectories
    Remove {
        id: String,
    },
}
#[derive(Subcommand)]
enum Session {
    List {
        #[arg(long, default_value_t = 20)]
        limit: usize,
        #[arg(long)]
        search: Option<String>,
        #[arg(long)]
        since: Option<String>,
    },
    Show {
        id: String,
    },
    Export {
        id: String,
        #[arg(long, short)]
        output: PathBuf,
    },
}
fn output(value: Value, json_mode: bool) {
    if json_mode {
        println!("{}", serde_json::to_string_pretty(&value).unwrap());
        return;
    }
    if let Some(rows) = value.as_array() {
        for row in rows {
            if row.get("sessionId").is_some() {
                println!(
                    "{}  {}  {}  {}",
                    row["id"].as_str().unwrap_or(""),
                    row["status"].as_str().unwrap_or(""),
                    row["model"].as_str().unwrap_or(""),
                    row["title"].as_str().unwrap_or("")
                );
            } else if row.get("count").is_some() {
                println!(
                    "{}  {}  {:>4} requests  {}",
                    row["id"].as_str().unwrap_or(""),
                    row["updatedAt"].as_str().unwrap_or(""),
                    row["count"],
                    row["title"].as_str().unwrap_or("")
                );
            } else {
                println!(
                    "{}  {}  {}{}",
                    row["id"].as_str().unwrap_or(""),
                    row["name"].as_str().unwrap_or(""),
                    row["url"].as_str().unwrap_or(""),
                    if row["active"] == true {
                        "  [active]"
                    } else {
                        ""
                    }
                );
            }
        }
        if rows.is_empty() {
            println!("No records.");
        }
    } else {
        println!("{}", serde_json::to_string_pretty(&value).unwrap());
    }
}
fn main() {
    if let Err(e) = run() {
        eprintln!("error: {e:#}");
        std::process::exit(1)
    }
}
fn run() -> Result<()> {
    let args = Args::parse();
    let runtime = Runtime::load(args.home, args.port, args.runtime_dir)?;
    let value = match args.command {
        Commands::Start => runtime.start()?,
        Commands::Serve => {
            runtime.serve()?;
            return Ok(());
        }
        Commands::Stop => runtime.stop()?,
        Commands::Restart => {
            runtime.stop()?;
            runtime.start()?
        }
        Commands::Status => {
            json!({"running":runtime.running(),"url":runtime.base(),"home":runtime.home,"version":VERSION})
        }
        Commands::Config => {
            json!({"home":runtime.home,"port":runtime.config.port,"url":runtime.base(),"runtime":runtime.node_path().ok()})
        }
        Commands::Open => {
            runtime.start()?;
            trace_runtime::open_browser(&runtime.base())?;
            json!({"url":runtime.base()})
        }
        Commands::Import { from } => runtime.import_data(&from)?,
        Commands::Backup { command } => runtime.backup(match command {
            Backup::Enable => Some(true),
            Backup::Disable => Some(false),
            Backup::Status => None,
        })?,
        Commands::Service {
            action,
            dry_run,
            desktop,
        } => service::manage(&runtime, &action, dry_run, desktop)?,
        Commands::Provider { command } => match command {
            Provider::List => {
                let state = runtime.get("/api/state")?;
                let mut rows = state["providers"]
                    .as_array()
                    .context("Invalid provider list")?
                    .clone();
                for p in &mut rows {
                    p["active"] = json!(p["id"] == state["defaultProviderId"]);
                }
                json!(rows)
            }
            Provider::Current => {
                let state = runtime.get("/api/state")?;
                state["providers"]
                    .as_array()
                    .context("Invalid provider list")?
                    .iter()
                    .find(|p| p["id"] == state["defaultProviderId"])
                    .cloned()
                    .unwrap_or(Value::Null)
            }
            Provider::Add {
                name,
                url,
                protocol,
                activate,
            } => {
                let p = runtime.send(
                    "POST",
                    "/api/providers",
                    json!({"name":name,"url":url,"protocol":protocol}),
                    false,
                )?;
                if activate {
                    runtime.send(
                        "POST",
                        "/api/admin/provider/use",
                        json!({"id":p["id"]}),
                        true,
                    )?;
                }
                p
            }
            Provider::Use { id } => {
                let p = runtime.provider(&id)?;
                runtime.send(
                    "POST",
                    "/api/admin/provider/use",
                    json!({"id":p["id"]}),
                    true,
                )?;
                p
            }
            Provider::Url { id } => {
                let state = runtime.get("/api/state")?;
                let id = id.unwrap_or_else(|| {
                    state["defaultProviderId"]
                        .as_str()
                        .unwrap_or("")
                        .to_string()
                });
                let p = runtime.provider(&id)?;
                json!({"provider":p["name"],"openai":p["openaiUrl"],"anthropic":p["localUrl"],"apiKey":"Use your upstream Provider API key in the Harness; it is never stored here."})
            }
            Provider::Remove { id } => {
                let p = runtime.provider(&id)?;
                runtime.send(
                    "DELETE",
                    &format!(
                        "/api/admin/provider/{}",
                        p["id"].as_str().context("Invalid ID")?
                    ),
                    json!({}),
                    true,
                )?
            }
        },
        Commands::Session { command } => match command {
            Session::List {
                limit,
                search,
                since,
            } => {
                if let Some(ref date) = since {
                    if date.len() < 10
                        || date.as_bytes().get(4) != Some(&b'-')
                        || date.as_bytes().get(7) != Some(&b'-')
                    {
                        bail!(
                            "--since expects an ISO date, e.g. 2026-10-19 or 2026-10-19T10:00:00Z"
                        );
                    }
                }
                let state = runtime.get("/api/state")?;
                json!(state["sessions"]
                    .as_array()
                    .context("Invalid session list")?
                    .iter()
                    .filter(|s| search
                        .as_ref()
                        .is_none_or(|q| s.to_string().to_lowercase().contains(&q.to_lowercase()))
                        && since
                            .as_ref()
                            .is_none_or(|t| s["updatedAt"].as_str().unwrap_or("") >= t.as_str()))
                    .take(limit)
                    .collect::<Vec<_>>())
            }
            Session::Show { id } => {
                runtime.get(&format!("/api/sessions/{}", urlencoding::encode(&id)))?
            }
            Session::Export { id, output } => {
                let data = runtime.get(&format!(
                    "/api/sessions/{}?export=1",
                    urlencoding::encode(&id)
                ))?;
                if data.as_array().is_none_or(|a| a.is_empty()) {
                    bail!("Session not found or empty");
                }
                if output.exists() {
                    bail!(
                        "Output already exists; refusing to overwrite {}",
                        output.display()
                    );
                }
                if let Some(parent) = output.parent() {
                    if !parent.as_os_str().is_empty() {
                        fs::create_dir_all(parent)?;
                    }
                }
                trace_runtime::private_write(&output, &serde_json::to_vec_pretty(&data)?)?;
                json!({"exported":output,"redacted":true})
            }
        },
    };
    output(value, args.json);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn global_flags_work_after_subcommand() {
        let args = Args::try_parse_from(["trace", "status", "--json", "--port", "44317"]).unwrap();
        assert!(args.json);
        assert_eq!(args.port, Some(44317));
    }
    #[test]
    fn provider_configuration_has_no_key_option() {
        assert!(Args::try_parse_from([
            "trace",
            "provider",
            "add",
            "--name",
            "test",
            "--url",
            "https://example.com",
            "--api-key",
            "secret"
        ])
        .is_err());
    }
    #[test]
    fn backup_commands_accept_global_flags() {
        for action in ["enable", "disable", "status"] {
            let args =
                Args::try_parse_from(["trace", "backup", action, "--json", "--home", "test-home"])
                    .unwrap();
            assert!(matches!(args.command, Commands::Backup { .. }));
            assert!(args.json);
        }
        assert!(Args::try_parse_from(["trace", "backup", "unknown"]).is_err());
    }
    #[test]
    fn service_install_is_explicit() {
        let args = Args::try_parse_from(["trace", "service", "install", "--dry-run"]).unwrap();
        assert!(matches!(
            args.command,
            Commands::Service {
                dry_run: true,
                desktop: false,
                ..
            }
        ));
    }
}
