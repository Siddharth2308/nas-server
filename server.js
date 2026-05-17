'use strict';

const https    = require('https');
const http     = require('http');
const fs       = require('fs');
const os       = require('os');
const { exec } = require('child_process');
const express  = require('express');
const cors     = require('cors');
require('dotenv').config();

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PORT          = parseInt(process.env.PORT           || '8082');
const SSL_CERT      = process.env.SSL_CERT                || '/etc/caddy/ubuntu-server.tailf009e6.ts.net.crt';
const SSL_KEY       = process.env.SSL_KEY                 || '/etc/caddy/ubuntu-server.tailf009e6.ts.net.key';
const TS_API_KEY    = process.env.TAILSCALE_API_KEY       || '';
const TS_TAILNET    = process.env.TAILSCALE_TAILNET       || 'tailf009e6.ts.net';
// Nextcloud AIO uses Apache container on port 11000; Caddy reverse-proxies to it.
// Hit localhost:11000 directly so the health check doesn't round-trip through Caddy/Tailscale.
const NEXTCLOUD_URL = process.env.NEXTCLOUD_URL           || 'http://localhost:11000';

// All disk partitions that matter on margaret.
// Stored as an array so /space/all can iterate them in one shot.
const MOUNTS = [
    { name: 'SSD — Root',           mount: process.env.MOUNT_ROOT       || '/'                   },
    { name: 'HDD — Nextcloud Data', mount: process.env.MOUNT_NC_DATA    || '/mnt/nextcloud-data' },
    { name: 'HDD — Siddharth Main', mount: process.env.MOUNT_SIDDH_MAIN || '/mnt/siddharth_main' },
    { name: 'HDD — Siddharth 1',    mount: process.env.MOUNT_SIDDH_1    || '/mnt/siddharth_1'    },
    { name: 'HDD — Vigyan Ashram',  mount: process.env.MOUNT_VA         || '/mnt/sda4'            },
];

// ── APP ───────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ── HELPERS ───────────────────────────────────────────────────────────────────

function sh(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 10000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr.trim() || err.message));
            resolve(stdout.trim());
        });
    });
}

function readProc(file) {
    return fs.readFileSync(file, 'utf8');
}

// Two /proc/stat samples 600 ms apart → CPU usage %
function getCpuUsage() {
    function sample() {
        const line = readProc('/proc/stat').split('\n')[0];
        const nums = line.trim().split(/\s+/).slice(1).map(Number);
        const [user, nice, system, idle, iowait, irq, softirq, steal] = nums;
        const total = user + nice + system + idle + iowait + irq + softirq + steal;
        return { idle, total };
    }
    const s1 = sample();
    return new Promise(resolve => {
        setTimeout(() => {
            const s2 = sample();
            const idleDelta  = s2.idle  - s1.idle;
            const totalDelta = s2.total - s1.total;
            const usage = totalDelta === 0 ? 0 : (1 - idleDelta / totalDelta) * 100;
            resolve(Math.round(usage * 10) / 10);
        }, 600);
    });
}

// RAM from /proc/meminfo — uses MemAvailable (accounts for reclaimable cache)
function getRamInfo() {
    const raw = readProc('/proc/meminfo');
    const get = key => {
        const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
        return m ? parseInt(m[1]) * 1024 : 0;
    };
    const total     = get('MemTotal');
    const available = get('MemAvailable');
    const used      = total - available;
    const pct       = total ? Math.round((used / total) * 1000) / 10 : 0;
    return {
        total:       fmtBytes(total),
        used:        fmtBytes(used),
        available:   fmtBytes(available),
        usedPercent: `${pct}%`,
        pct,
        totalRaw:    total,
        usedRaw:     used,
    };
}

// `df -B1` gives exact byte counts; works on both ext4 and ntfs mounts
async function getDiskInfo(mount) {
    const out  = await sh(`df -B1 "${mount}"`);
    const line = out.split('\n')[1].trim().split(/\s+/);
    const total     = parseInt(line[1]);
    const used      = parseInt(line[2]);
    const available = parseInt(line[3]);
    const pct       = total ? Math.round((used / total) * 1000) / 10 : 0;
    return {
        filesystem:  line[0],
        mount:       line[5] ?? mount,
        total:       fmtBytes(total),
        used:        fmtBytes(used),
        available:   fmtBytes(available),
        usedPercent: `${pct}%`,
        pct,
        totalRaw:    total,
        usedRaw:     used,
    };
}

function fmtBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// Returns 'active' or 'inactive' for a systemd unit — never throws
async function svcActive(name) {
    try { await sh(`systemctl is-active --quiet ${name}`); return 'active'; }
    catch { return 'inactive'; }
}

// Docker ps — returns all running containers as a normalised array
async function getDockerContainers() {
    const out = await sh(`docker ps --format '{{json .}}'`);
    return out
        .split('\n')
        .filter(Boolean)
        .map(line => {
            const c = JSON.parse(line);
            return {
                name:   c.Names.replace(/^\//, ''),
                image:  c.Image,
                status: c.Status.toLowerCase().startsWith('up') ? 'running' : 'stopped',
                uptime: c.Status,
                ports:  c.Ports || '—',
            };
        });
}

// Nextcloud AIO health — checks key containers + HTTP status endpoint
async function getNextcloudStatus() {
    // These are the containers that must be up for Nextcloud to function
    const KEY_CONTAINERS = [
        'nextcloud-aio-mastercontainer',
        'nextcloud-aio-apache',
        'nextcloud-aio-nextcloud',
        'nextcloud-aio-database',
        'nextcloud-aio-redis',
    ];

    const containerStatuses = {};
    await Promise.all(
        KEY_CONTAINERS.map(async name => {
            try {
                // Returns "running", "exited", etc.
                const state = await sh(
                    `docker inspect --format '{{.State.Status}}' ${name}`
                );
                containerStatuses[name] = state;
            } catch {
                containerStatuses[name] = 'not found';
            }
        })
    );

    // HTTP health check against Apache container (port 11000, no TLS needed)
    let httpStatus = null;
    try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 5000);
        const res  = await fetch(`${NEXTCLOUD_URL}/status.php`, { signal: ctrl.signal });
        clearTimeout(tid);
        if (res.ok) {
            const json = await res.json();
            httpStatus = {
                installed:   json.installed,
                maintenance: json.maintenance,
                version:     json.versionstring || json.version,
                productname: json.productname,
            };
        } else {
            httpStatus = { error: `HTTP ${res.status}` };
        }
    } catch (e) {
        httpStatus = { error: e.name === 'AbortError' ? 'timeout' : e.message };
    }

    return { containers: containerStatuses, http: httpStatus };
}

// Tailscale control-plane API — live connectedToControl status per device
async function getTailscaleDevices() {
    if (!TS_API_KEY) throw new Error('TAILSCALE_API_KEY not set in .env');
    const url = `https://api.tailscale.com/api/v2/tailnet/${TS_TAILNET}/devices`;
    const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${TS_API_KEY}` },
    });
    if (!res.ok) throw new Error(`Tailscale API ${res.status}: ${await res.text()}`);
    const data = await res.json();

    return (data.devices || []).map(d => {
        const connected = d.connectedToControl === true;
        return {
            name:      d.hostname || d.name,
            owner:     d.user,
            ip:        (d.addresses || [])[0] || '',
            version:   d.clientVersion || '',
            os:        d.os || '',
            seen:      connected ? 'connected' : (d.lastSeen || 'unknown'),
            connected,
        };
    });
}

// ── ROUTES ────────────────────────────────────────────────────────────────────

// Client IP reflection — frontend uses this to detect Tailscale connectivity.
// If the server sees a 100.64–100.127 source address, the client is on Tailscale.
app.get('/myip', (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
        .split(',')[0].trim().replace('::ffff:', '');
    res.json({ ip });
});

// Server liveness + key service states
app.get('/status', async (req, res) => {
    const [caddy, tailscaled] = await Promise.all([
        svcActive('caddy'),
        svcActive('tailscaled'),
    ]);
    res.json({
        success:   true,
        hostname:  os.hostname(),
        uptime:    os.uptime(),
        platform:  os.platform(),
        arch:      os.arch(),
        loadavg:   os.loadavg(),
        time:      new Date().toISOString(),
        services:  { caddy, tailscaled },
    });
});

// CPU % + RAM
app.get('/metrics', async (req, res) => {
    try {
        const [cpu, ram] = await Promise.all([getCpuUsage(), Promise.resolve(getRamInfo())]);
        res.json({
            success: true,
            cpu: {
                usage:   cpu,
                cores:   os.cpus().length,
                model:   os.cpus()[0]?.model || '',
                loadavg: os.loadavg(),
            },
            ram,
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// All disk partitions in one call — preferred endpoint for the frontend
app.get('/space/all', async (req, res) => {
    const results = await Promise.allSettled(
        MOUNTS.map(m => getDiskInfo(m.mount).then(info => ({ ...info, name: m.name })))
    );
    const disks = results.map((r, i) =>
        r.status === 'fulfilled'
            ? r.value
            : { name: MOUNTS[i].name, mount: MOUNTS[i].mount, error: r.reason.message }
    );
    res.json({ success: true, disks });
});

// Keep individual endpoints for backward compatibility
app.get('/space/ssd', async (req, res) => {
    try {
        const info = await getDiskInfo(MOUNTS[0].mount); // Root SSD
        res.json({ success: true, name: MOUNTS[0].name, ...info });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/space/hdd', async (req, res) => {
    try {
        const info = await getDiskInfo(MOUNTS[1].mount); // Nextcloud data (largest HDD partition)
        res.json({ success: true, name: MOUNTS[1].name, ...info });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// All Docker containers (not just Nextcloud — let the frontend filter if needed)
app.get('/docker/containers', async (req, res) => {
    try {
        const containers = await getDockerContainers();
        res.json({ success: true, containers });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Nextcloud AIO health (container states + HTTP /status.php)
app.get('/nextcloud', async (req, res) => {
    try {
        const status = await getNextcloudStatus();
        res.json({ success: true, ...status });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Tailscale devices via control-plane API
app.get('/tailscale/devices', async (req, res) => {
    try {
        const devices = await getTailscaleDevices();
        res.json({ success: true, devices });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Ping a device by Tailscale IP — only IPs in the 100.64/10 block are accepted
app.get('/ping/:ip', async (req, res) => {
    const ip = req.params.ip;
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        return res.status(400).json({ success: false, error: 'Invalid IP' });
    }
    try {
        const out = await sh(`ping -c 3 -W 2 ${ip}`);
        const m   = out.match(/rtt[^=]+=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
        if (m) {
            res.json({ success: true, latency_ms: parseFloat(m[2]) }); // avg RTT
        } else {
            res.json({ success: false, error: 'No response' });
        }
    } catch {
        res.json({ success: false, error: 'Unreachable' });
    }
});

// ── START ─────────────────────────────────────────────────────────────────────
function start() {
    const certExists = fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY);

    if (certExists) {
        const creds = { cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) };
        https.createServer(creds, app).listen(PORT, () => {
            console.log(`[nas-server] HTTPS ▸ port ${PORT}`);
            console.log(`[nas-server] Cert  ▸ ${SSL_CERT}`);
        });
    } else {
        console.warn(`[nas-server] SSL certs not found — falling back to HTTP`);
        console.warn(`  Expected cert: ${SSL_CERT}`);
        console.warn(`  Expected key:  ${SSL_KEY}`);
        http.createServer(app).listen(PORT, () => {
            console.log(`[nas-server] HTTP ▸ port ${PORT} (no TLS)`);
        });
    }
}

start();
