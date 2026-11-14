//! Just enough MCP over stdio: newline-delimited JSON-RPC 2.0.

use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::setup::{Out, Server};

pub const PROTOCOL_VERSION: &str = "2025-06-18";

#[derive(Debug)]
pub enum McpError {
    /// The server's stdout closed. Its exit code and last stderr lines say why.
    Exited { code: Option<i32>, stderr: Vec<String> },
    Timeout { after: Duration, junk: usize },
    Rpc(Value),
    Write(std::io::Error),
    LineTooLong(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::Exited { code, stderr } => {
                write!(f, "server exited (code {code:?}) before answering. Last stderr: {:?}", stderr)
            }
            McpError::Timeout { after, junk } => write!(f, "no answer within {after:?} ({junk} non-JSON-RPC stdout lines skipped)"),
            McpError::Rpc(e) => write!(f, "JSON-RPC error {e}"),
            McpError::Write(e) => write!(f, "writing to stdin failed: {e}"),
            McpError::LineTooLong(head) => write!(f, "stdout line over the cap, starting {head:?}"),
        }
    }
}

pub struct Client {
    pub server: Server,
    next_id: u64,
    /// stdout lines that weren't JSON-RPC messages, skipped.
    pub junk: Vec<String>,
    pub notifications: Vec<String>,
}

impl Client {
    pub fn new(server: Server) -> Client {
        Client { server, next_id: 1, junk: Vec::new(), notifications: Vec::new() }
    }

    fn exited(&mut self) -> McpError {
        // Give the process a moment to finish so its code is known.
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut code = None;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = self.server.child.try_wait() {
                code = status.code();
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        std::thread::sleep(Duration::from_millis(200));
        McpError::Exited { code, stderr: self.server.stderr_tail(8) }
    }

    pub fn request(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, McpError> {
        let id = self.next_id;
        self.next_id += 1;
        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.server.send_line(&msg.to_string()) {
            // A closed pipe usually means the server is gone. Report the exit if so.
            if self.server.child.try_wait().ok().flatten().is_some() {
                return Err(self.exited());
            }
            return Err(McpError::Write(e));
        }
        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match self.server.stdout.recv_timeout(left) {
                Ok(Out::Line(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let Ok(v) = serde_json::from_str::<Value>(&line) else {
                        self.junk.push(line);
                        continue;
                    };
                    if v.get("jsonrpc") != Some(&json!("2.0")) {
                        self.junk.push(line);
                        continue;
                    }
                    let has_method = v.get("method").is_some();
                    if let (true, Some(req_id)) = (has_method, v.get("id")) {
                        // A request from the server (ping, roots/list, sampling). The spike answers ping and declines the rest.
                        let reply = if v["method"] == "ping" {
                            json!({ "jsonrpc": "2.0", "id": req_id, "result": {} })
                        } else {
                            json!({ "jsonrpc": "2.0", "id": req_id, "error": { "code": -32601, "message": "Not supported" } })
                        };
                        let _ = self.server.send_line(&reply.to_string());
                        continue;
                    }
                    if has_method {
                        self.notifications.push(v["method"].as_str().unwrap_or("?").to_string());
                        continue;
                    }
                    if v.get("id") == Some(&json!(id)) {
                        if let Some(err) = v.get("error") {
                            return Err(McpError::Rpc(err.clone()));
                        }
                        return Ok(v.get("result").cloned().unwrap_or(Value::Null));
                    }
                    self.junk.push(line);
                }
                Ok(Out::TooLong(head)) => return Err(McpError::LineTooLong(head)),
                Ok(Out::Eof) | Err(RecvTimeoutError::Disconnected) => return Err(self.exited()),
                Err(RecvTimeoutError::Timeout) => return Err(McpError::Timeout { after: timeout, junk: self.junk.len() }),
            }
        }
    }

    pub fn notify(&mut self, method: &str) -> Result<(), McpError> {
        let msg = json!({ "jsonrpc": "2.0", "method": method });
        self.server.send_line(&msg.to_string()).map_err(McpError::Write)
    }

    /// initialize, then notifications/initialized. Returns the server's name and version.
    pub fn initialize(&mut self, timeout: Duration) -> Result<String, McpError> {
        let result = self.request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "familiar-spike", "version": "0.0.0" }
            }),
            timeout,
        )?;
        self.notify("notifications/initialized")?;
        Ok(format!(
            "{} {} (protocol {})",
            result["serverInfo"]["name"].as_str().unwrap_or("?"),
            result["serverInfo"]["version"].as_str().unwrap_or("?"),
            result["protocolVersion"].as_str().unwrap_or("?")
        ))
    }

    pub fn list_tools(&mut self, timeout: Duration) -> Result<Vec<String>, McpError> {
        let result = self.request("tools/list", json!({}), timeout)?;
        Ok(result["tools"]
            .as_array()
            .map(|a| a.iter().filter_map(|t| t["name"].as_str().map(String::from)).collect())
            .unwrap_or_default())
    }

    /// tools/call. Returns the text parts joined, and whether the tool said it failed.
    pub fn call(&mut self, name: &str, args: Value, timeout: Duration) -> Result<(String, bool), McpError> {
        let result = self.request("tools/call", json!({ "name": name, "arguments": args }), timeout)?;
        let text = result["content"]
            .as_array()
            .map(|a| a.iter().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n"))
            .unwrap_or_default();
        Ok((text, result["isError"] == json!(true)))
    }
}
