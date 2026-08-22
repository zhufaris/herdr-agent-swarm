module.exports = {
  apps: [{
    name: "herdr-lark-bridge",
    cwd: __dirname,
    script: "/bin/bash",
    args: ["-lc", "set -a; . ./.env; set +a; exec npm start"],
    interpreter: "none",
    autorestart: true,
    restart_delay: 5_000,
    kill_timeout: 3_660_000,
    time: true
  }]
};
