import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import {
  toBeatriceFont,
  validateAppState,
  parseCommandInput,
  formatUptime,
} from './src/utils/beatriceCore.ts';
import { redactSecrets } from './src/utils/sanitizer.ts';
import { WireGuardService } from './src/utils/wireguardService.ts';
import {
  checkFcaUpdates,
  getFcaSettings,
  saveFcaSettings,
  getFcaHistory,
  getInstalledFcaVersion,
} from './src/utils/fcaUpdateChecker.ts';
import { geminiKeyManager } from './src/utils/geminiKeyManager.ts';
import { executeGeminiChat } from './src/utils/geminiService.ts';
import { kokoroTtsService } from './src/utils/kokoroService.ts';
import { runPreflightCheck } from './src/utils/preflightCheck.ts';
import { runSetup } from './src/setup/index.ts';
import { runSystemDoctor } from './src/setup/doctor.ts';
import { createRequire } from 'module';

const requireCommonJS = createRequire(import.meta.url);
const pathResolver = requireCommonJS('./Beatrice-fca/core/bootstrap/pathResolver.js');
const { personaController } = requireCommonJS('./Beatrice-fca/persona/persona-controller.js');
const { personaStorage } = requireCommonJS('./Beatrice-fca/persona/storage/db.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const BEATRICE_DIR = path.resolve(__dirname, 'Beatrice-fca');

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// In-memory logs buffer
export interface LogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'fca' | 'cmd';
  message: string;
}

const logsBuffer: LogEntry[] = [];
const MAX_LOGS = 500;
const sseClients: Response[] = [];

export function addLog(level: LogEntry['level'], rawMessage: string) {
  const sanitized = redactSecrets(rawMessage);
  const entry: LogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: new Date().toLocaleTimeString(),
    level,
    message: sanitized,
  };
  logsBuffer.unshift(entry);
  if (logsBuffer.length > MAX_LOGS) {
    logsBuffer.pop();
  }

  // Push to active SSE connections
  for (let i = sseClients.length - 1; i >= 0; i--) {
    const client = sseClients[i];
    try {
      client.write(`data: ${JSON.stringify(entry)}\n\n`);
    } catch {
      sseClients.splice(i, 1);
    }
  }
}

// Initialize WireGuard & Proton VPN service
const wireguard = new WireGuardService(__dirname);

// Initial bootstrap logs
addLog('info', 'Beatrice-fca management server initializing...');
addLog('info', 'Loaded Beatrice-fca modules, WireGuard tunnel manager, and FCA update engine.');

// Non-blocking auto-setup validation
runSetup(__dirname, { auto: true, silent: true })
  .then((report) => {
    if (report.canBootBot) {
      addLog('info', 'First-run setup check: All core assets and dependencies verified.');
    } else {
      addLog('warn', `First-run setup warning: ${report.errors.join(', ')}`);
    }
  })
  .catch((err) => {
    addLog('warn', `Auto-setup background check notice: ${err?.message || err}`);
  });

// Process & Supervisor state
interface CrashRecord {
  timestamp: number;
  exitCode: number | null;
  reason: string;
}

let botProcess: ChildProcess | null = null;
let botStartTime: number | null = null;
let botStatus: 'stopped' | 'running' | 'simulated' | 'starting' | 'error' = 'simulated';
let consecutiveImmediateCrashes = 0;
const MAX_CONSECUTIVE_CRASHES = 3;
const botStderrBuffer: string[] = [];
let botBootTimer: NodeJS.Timeout | null = null;
let lastCrashRecord: CrashRecord | null = null;

export function getSupervisorDiagnostics() {
  return {
    botStatus,
    consecutiveImmediateCrashes,
    maxConsecutiveCrashes: MAX_CONSECUTIVE_CRASHES,
    isLockedInError: consecutiveImmediateCrashes >= MAX_CONSECUTIVE_CRASHES,
    lastCrashRecord,
    recentStderr: botStderrBuffer.slice(-5),
  };
}

export function resetSupervisorLock() {
  consecutiveImmediateCrashes = 0;
  lastCrashRecord = null;
}

// Start bot process handler with crash loop prevention and boot verification
function startBotProcess() {
  if (botProcess) {
    addLog('warn', 'Bot process is already running.');
    return;
  }

  // Prevent fast restart loop
  if (consecutiveImmediateCrashes >= MAX_CONSECUTIVE_CRASHES) {
    addLog(
      'error',
      `[Supervisor] Fast restart loop prevented. Bot crashed ${consecutiveImmediateCrashes} times consecutively (Last error: ${lastCrashRecord?.reason || 'Exit failure'}). Please fix the issue or click Restart to reset.`
    );
    botStatus = 'error';
    return;
  }

  const preflight = runPreflightCheck();
  if (!preflight.canBoot) {
    addLog('error', preflight.summaryText);
    botStatus = 'error';
    return;
  }
  if (preflight.missingOptional.length > 0) {
    addLog('warn', `Preflight: Running with ${preflight.missingOptional.length} optional feature(s) disabled.`);
  }

  addLog('info', 'Spawning Beatrice bot (node index.js)...');
  botStatus = 'starting';
  botStderrBuffer.length = 0; // Clear recent stderr

  try {
    botProcess = spawn('node', ['index.js'], {
      cwd: BEATRICE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PORT: '3001' },
      shell: true,
    });

    botStartTime = Date.now();
    addLog('info', `Bot process spawned (PID: ${botProcess.pid})`);

    // Verify healthy boot after 4 seconds of stable execution
    if (botBootTimer) clearTimeout(botBootTimer);
    botBootTimer = setTimeout(() => {
      if (botProcess && botStatus === 'starting') {
        botStatus = 'running';
        consecutiveImmediateCrashes = 0;
        addLog('info', '[Supervisor] Bot process confirmed healthy and running.');
      }
    }, 4000);

    botProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (!text) return;
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.includes('FCA') || line.includes('MQTT') || line.includes('Heartbeat')) {
          addLog('fca', line.trim());
        } else {
          addLog('info', line.trim());
        }

        // Promote to running if startup indicator is seen
        if (line.includes('Bootstrap complete') || line.includes('AutoGit') || line.includes('connected')) {
          botStatus = 'running';
          consecutiveImmediateCrashes = 0;
        }
      }
    });

    botProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim();
      if (!text) return;
      botStderrBuffer.push(text);
      if (botStderrBuffer.length > 10) botStderrBuffer.shift();
      addLog('warn', text);
    });

    botProcess.on('close', (code) => {
      if (botBootTimer) {
        clearTimeout(botBootTimer);
        botBootTimer = null;
      }

      const runtimeMs = botStartTime ? Date.now() - botStartTime : 0;
      botProcess = null;
      botStartTime = null;

      if (runtimeMs < 4000 && code !== 0) {
        consecutiveImmediateCrashes++;
        const failureReason = botStderrBuffer.slice(-2).join(' ') || `Process exited immediately with code ${code}`;
        lastCrashRecord = {
          timestamp: Date.now(),
          exitCode: code,
          reason: failureReason,
        };
        botStatus = 'error';
        addLog('error', `[Supervisor] Immediate startup crash #${consecutiveImmediateCrashes}/${MAX_CONSECUTIVE_CRASHES} (Code ${code}): ${failureReason}`);

        if (consecutiveImmediateCrashes >= MAX_CONSECUTIVE_CRASHES) {
          addLog('error', `[Supervisor] Crash loop threshold exceeded. Bot held in ERROR state to protect system resources.`);
        }
      } else if (code === 0) {
        botStatus = 'stopped';
        consecutiveImmediateCrashes = 0;
        addLog('info', `[Supervisor] Bot process exited normally (Code 0).`);
      } else {
        botStatus = 'stopped';
        consecutiveImmediateCrashes = 0;
        addLog('warn', `[Supervisor] Bot process stopped after running for ${Math.round(runtimeMs / 1000)}s (Code ${code}).`);
      }
    });

    botProcess.on('error', (err) => {
      if (botBootTimer) {
        clearTimeout(botBootTimer);
        botBootTimer = null;
      }
      addLog('error', `Failed to spawn bot process: ${err.message}`);
      botProcess = null;
      botStartTime = null;
      botStatus = 'error';
    });
  } catch (err: unknown) {
    if (botBootTimer) {
      clearTimeout(botBootTimer);
      botBootTimer = null;
    }
    const error = err as Error;
    addLog('error', `Error spawning bot: ${error.message}`);
    botStatus = 'error';
  }
}

function stopBotProcess() {
  if (botBootTimer) {
    clearTimeout(botBootTimer);
    botBootTimer = null;
  }
  if (botProcess) {
    addLog('info', 'Stopping bot process...');
    botProcess.kill('SIGTERM');
    botProcess = null;
  }
  botStartTime = null;
  botStatus = 'stopped';
}


// Scans commands directory in Beatrice-fca/scripts/cmds
interface ParsedCommandMeta {
  name: string;
  category: string;
  role: number;
  description: string;
  guide: string;
  aliases: string[];
  cooldown: number;
  author?: string;
  filePath: string;
}

function getCommandsList(): ParsedCommandMeta[] {
  const cmdsDir = path.join(BEATRICE_DIR, 'scripts', 'cmds');
  const results: ParsedCommandMeta[] = [];

  if (!fs.existsSync(cmdsDir)) return results;

  const categories = fs.readdirSync(cmdsDir);
  for (const cat of categories) {
    const catPath = path.join(cmdsDir, cat);
    if (!fs.statSync(catPath).isDirectory()) continue;

    const files = fs.readdirSync(catPath);
    for (const f of files) {
      if (!f.endsWith('.js') && !f.endsWith('.ts')) continue;
      const filePath = path.join(catPath, f);
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // Extract config block from module.exports.config = { ... }
        const nameMatch = content.match(/name:\s*["']([^"']+)["']/);
        const roleMatch = content.match(/role:\s*([0-9]+)/);
        const descMatch = content.match(/description:\s*(?:\{[^}]*\}|["']([^"']+)["'])/);
        const guideMatch = content.match(/guide:\s*(?:\{[^}]*\}|["']([^"']+)["'])/);
        const cooldownMatch = content.match(/cooldowns?:\s*([0-9]+)/);
        const authorMatch = content.match(/author:\s*["']([^"']+)["']/);

        let description = 'Facebook messenger bot command';
        if (descMatch) {
          if (descMatch[1]) {
            description = descMatch[1];
          } else {
            const enDesc = content.match(/en:\s*["']([^"']+)["']/);
            if (enDesc) description = enDesc[1];
          }
        }

        let guide = '';
        if (guideMatch) {
          if (guideMatch[1]) {
            guide = guideMatch[1];
          } else {
            const enGuide = content.match(/guide:[\s\S]*?en:\s*["']([^"']+)["']/);
            if (enGuide) guide = enGuide[1];
          }
        }

        const name = nameMatch ? nameMatch[1] : path.basename(f, path.extname(f));
        const role = roleMatch ? parseInt(roleMatch[1], 10) : 0;
        const cooldown = cooldownMatch ? parseInt(cooldownMatch[1], 10) : 5;
        const author = authorMatch ? authorMatch[1] : 'Beatrice Team';

        results.push({
          name,
          category: cat,
          role,
          description,
          guide,
          aliases: [],
          cooldown,
          author,
          filePath: path.relative(BEATRICE_DIR, filePath),
        });
      } catch {
        // Fallback simple entry
        results.push({
          name: path.basename(f, path.extname(f)),
          category: cat,
          role: 0,
          description: 'Custom command',
          guide: '',
          aliases: [],
          cooldown: 5,
          filePath: path.relative(BEATRICE_DIR, filePath),
        });
      }
    }
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// Scans events directory
function getEventsList(): Array<{ name: string; filePath: string }> {
  const eventsDir = path.join(BEATRICE_DIR, 'scripts', 'events');
  if (!fs.existsSync(eventsDir)) return [];
  const files = fs.readdirSync(eventsDir);
  return files
    .filter((f) => f.endsWith('.js') || f.endsWith('.ts'))
    .map((f) => ({
      name: path.basename(f, path.extname(f)),
      filePath: path.join('scripts/events', f),
    }));
}

// Helper to read config.json
function getBeatriceConfig() {
  const configPath = path.join(BEATRICE_DIR, 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      return {};
    }
  }
  return {};
}

// Helper to read ncstate.json
function getBeatriceNcState() {
  const ncstatePath = pathResolver.getNcStatePath('ncstate.json');
  if (fs.existsSync(ncstatePath)) {
    try {
      const raw = fs.readFileSync(ncstatePath, 'utf-8');
      const validation = validateAppState(raw);
      return {
        raw,
        validation,
      };
    } catch {
      return { raw: '', validation: validateAppState('') };
    }
  }
  return { raw: '', validation: validateAppState('') };
}

// ----------------- API ROUTES ----------------- //

// GET /api/status
app.get('/api/status', async (_req: Request, res: Response) => {
  const config = getBeatriceConfig();
  const ncstate = getBeatriceNcState();
  const commands = getCommandsList();
  const events = getEventsList();
  const vpnStatus = await wireguard.getStatus();
  const fcaVersion = getInstalledFcaVersion(__dirname);
  const fcaSettings = getFcaSettings(__dirname);

  const mem = process.memoryUsage();
  const ramMB = Math.round(mem.rss / 1024 / 1024);

  const uptimeSec = botStartTime
    ? Math.floor((Date.now() - botStartTime) / 1000)
    : Math.floor(process.uptime());

  res.json({
    status: botStatus,
    pid: botProcess?.pid || null,
    uptime: uptimeSec,
    uptimeFormatted: formatUptime(uptimeSec),
    prefix: config.prefix || '.',
    botName: config.botName || 'Beatrice bc',
    nickNameBot: config.nickNameBot || '✨ Beatrice bc ✨',
    language: config.language || 'en',
    adminCount: Array.isArray(config.adminUIDs) ? config.adminUIDs.length : 1,
    commandsCount: commands.length,
    eventsCount: events.length,
    appstate: {
      isValid: ncstate.validation.isValid,
      userId: ncstate.validation.userId || config.facebookAccount?.i_user || null,
      totalCookies: ncstate.validation.totalCookies,
      isExpired: ncstate.validation.isExpired,
      expiresAt: ncstate.validation.expiresAt,
    },
    vpn: vpnStatus,
    fca: {
      installedVersion: fcaVersion,
      autoCheckEnabled: fcaSettings.autoCheckEnabled,
    },
    ram: `${ramMB} MB`,
    supervisor: getSupervisorDiagnostics(),
    env: {
      node: process.version,
      platform: process.platform,
      backend: 'sqlite3 / sql.js adaptive',
      canvas: '@napi-rs/canvas adaptive',
    },
  });
});

// GET /api/config
app.get('/api/config', (_req: Request, res: Response) => {
  const config = getBeatriceConfig();
  res.json(config);
});

// POST /api/config
app.post('/api/config', (req: Request, res: Response) => {
  try {
    const configPath = path.join(BEATRICE_DIR, 'config.json');
    const updated = req.body;
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2), 'utf-8');
    addLog('info', 'Bot configuration (config.json) updated successfully.');
    res.json({ success: true, message: 'Configuration saved.' });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ncstate
app.get('/api/ncstate', (_req: Request, res: Response) => {
  const ncstate = getBeatriceNcState();
  res.json(ncstate);
});

// POST /api/ncstate
app.post('/api/ncstate', (req: Request, res: Response) => {
  try {
    const { raw } = req.body;
    if (!raw) {
      return res.status(400).json({ error: 'Cookie content is empty' });
    }

    const validation = validateAppState(raw);
    const ncstatePath = pathResolver.getNcStatePath('ncstate.json');

    // Format json nicely
    const parsed = JSON.parse(raw);
    fs.writeFileSync(ncstatePath, JSON.stringify(parsed, null, 2), 'utf-8');

    addLog('fca', `Updated Facebook AppState (UserID: ${validation.userId || 'unknown'}). Valid: ${validation.isValid}`);
    res.json({ success: true, validation, message: 'AppState cookies saved successfully.' });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(400).json({ error: `Invalid AppState JSON: ${error.message}` });
  }
});

// GET /api/commands
app.get('/api/commands', (_req: Request, res: Response) => {
  const commands = getCommandsList();
  res.json(commands);
});

// GET /api/events
app.get('/api/events', (_req: Request, res: Response) => {
  const events = getEventsList();
  res.json(events);
});

// GET /api/logs
app.get('/api/logs', (_req: Request, res: Response) => {
  res.json(logsBuffer);
});

// POST /api/logs/clear
app.post('/api/logs/clear', (_req: Request, res: Response) => {
  logsBuffer.length = 0;
  addLog('info', 'Logs cleared by administrator.');
  res.json({ success: true });
});

// GET /api/logs/stream - Server-Sent Events for real-time live log terminal
app.get('/api/logs/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // Send initial snapshot
  res.write(`data: ${JSON.stringify({ type: 'init', logs: logsBuffer.slice(0, 50) })}\n\n`);

  sseClients.push(res);

  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) {
      sseClients.splice(idx, 1);
    }
  });
});

// ------------ WIREGUARD & PROTON VPN ROUTES ------------ //

// GET /api/vpn/status
app.get('/api/vpn/status', async (_req: Request, res: Response) => {
  const status = await wireguard.getStatus();
  res.json(status);
});

// GET /api/vpn/profiles
app.get('/api/vpn/profiles', (_req: Request, res: Response) => {
  const profiles = wireguard.listProfiles();
  res.json(profiles);
});

// POST /api/vpn/profiles/upload
app.post('/api/vpn/profiles/upload', (req: Request, res: Response) => {
  const { name, content } = req.body;
  if (!name || !content) {
    return res.status(400).json({ error: 'Profile filename and configuration content are required' });
  }

  const result = wireguard.saveProfile(name, content);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  addLog('info', `WireGuard profile "${result.profile?.name}" uploaded and validated successfully.`);
  res.json({ success: true, profile: result.profile });
});

// POST /api/vpn/profiles/select
app.post('/api/vpn/profiles/select', (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: 'Profile name required' });
  }

  const result = wireguard.selectProfile(name);
  if (!result.success) {
    return res.status(404).json({ error: result.error });
  }

  addLog('info', `Selected active WireGuard profile: "${result.selectedProfile}". Persisted for bot reboots.`);
  res.json(result);
});

// POST /api/vpn/profiles/rename
app.post('/api/vpn/profiles/rename', (req: Request, res: Response) => {
  const { oldName, newName } = req.body;
  if (!oldName || !newName) {
    return res.status(400).json({ error: 'Both oldName and newName are required' });
  }

  const result = wireguard.renameProfile(oldName, newName);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  addLog('info', `WireGuard profile renamed: "${oldName}" -> "${result.newName}".`);
  res.json(result);
});

// DELETE /api/vpn/profiles/:name
app.delete('/api/vpn/profiles/:name', (req: Request, res: Response) => {
  const name = req.params.name;
  if (!name) {
    return res.status(400).json({ error: 'Profile name required' });
  }

  const success = wireguard.deleteProfile(name);
  if (!success) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  addLog('info', `WireGuard profile "${name}" deleted.`);
  res.json({ success: true });
});

// GET /api/vpn/profiles/:name/view
app.get('/api/vpn/profiles/:name/view', (req: Request, res: Response) => {
  const name = req.params.name;
  const result = wireguard.getRedactedConfig(name);
  if (!result.success) {
    return res.status(404).json({ error: result.error });
  }
  res.json({ name, content: result.content });
});

// POST /api/vpn/connect
app.post('/api/vpn/connect', async (req: Request, res: Response) => {
  const { profileName } = req.body;
  addLog('info', `Initiating Proton VPN connection via WireGuard tunnel...`);
  const status = await wireguard.connect(profileName);
  if (status.status === 'connected') {
    addLog('info', `Proton VPN tunnel active. Public IP: ${status.publicIp} (Latency: ${status.pingMs}ms)`);
  } else if (status.status === 'error') {
    addLog('error', `Proton VPN connection error: ${status.errorMessage}`);
  }
  res.json(status);
});

// POST /api/vpn/disconnect
app.post('/api/vpn/disconnect', async (_req: Request, res: Response) => {
  addLog('info', 'Disconnecting WireGuard VPN tunnel...');
  const status = await wireguard.disconnect();
  addLog('info', 'WireGuard VPN disconnected. Traffic restored to default interface.');
  res.json(status);
});

// POST /api/vpn/killswitch
app.post('/api/vpn/killswitch', (req: Request, res: Response) => {
  const { enabled } = req.body;
  const state = wireguard.setKillSwitch(Boolean(enabled));
  addLog('info', `WireGuard KillSwitch / Leak Protection set to: ${state ? 'ENABLED' : 'DISABLED'}`);
  res.json({ success: true, killSwitchEnabled: state });
});

// POST /api/vpn/test
app.post('/api/vpn/test', async (_req: Request, res: Response) => {
  addLog('info', 'Testing public IP routing and latency...');
  const start = Date.now();
  const ip = await wireguard.fetchPublicIp();
  const latency = Date.now() - start;
  addLog('info', `Network test completed: Public egress IP is ${ip || 'Unknown'} (${latency}ms).`);
  res.json({ ip, latency, timestamp: new Date().toISOString() });
});

// ------------ FCA UPDATE ENGINE ROUTES ------------ //

// GET /api/fca/status
app.get('/api/fca/status', async (_req: Request, res: Response) => {
  const settings = getFcaSettings(__dirname);
  const history = getFcaHistory(__dirname);
  const latestCheck = history[0] || (await checkFcaUpdates(__dirname));

  res.json({
    settings,
    latestCheck,
    history: history.slice(0, 10),
  });
});

// POST /api/fca/check
app.post('/api/fca/check', async (_req: Request, res: Response) => {
  addLog('fca', 'Checking npm registry for modern @eryxenx/fca updates...');
  const result = await checkFcaUpdates(__dirname);
  addLog(
    result.hasUpdate ? 'warn' : 'fca',
    `FCA Version Audit: Current=${result.currentVersion}, Latest=${result.latestVersion}. Result: ${result.recommendedAction}`
  );
  res.json(result);
});

// GET /api/fca/history
app.get('/api/fca/history', (_req: Request, res: Response) => {
  const history = getFcaHistory(__dirname);
  res.json(history);
});

// POST /api/fca/settings
app.post('/api/fca/settings', (req: Request, res: Response) => {
  const { autoCheckEnabled, checkIntervalHours } = req.body;
  const current = getFcaSettings(__dirname);
  const updated = saveFcaSettings(__dirname, {
    ...current,
    autoCheckEnabled: typeof autoCheckEnabled === 'boolean' ? autoCheckEnabled : current.autoCheckEnabled,
    checkIntervalHours: typeof checkIntervalHours === 'number' ? checkIntervalHours : current.checkIntervalHours,
  });
  addLog('info', `FCA automated daily checker updated: Enabled=${updated.autoCheckEnabled}`);
  res.json(updated);
});

// POST /api/fca/decision
app.post('/api/fca/decision', (req: Request, res: Response) => {
  const { action, targetVersion, reason } = req.body;
  const current = getFcaSettings(__dirname);
  const updated = saveFcaSettings(__dirname, {
    ...current,
    lastDecision: {
      action: action || 'approved',
      targetVersion: targetVersion || getInstalledFcaVersion(__dirname),
      timestamp: new Date().toISOString(),
      reason: reason || 'Action authorized by administrator',
    },
  });
  addLog('fca', `FCA Update decision recorded: [${action?.toUpperCase()}] version ${targetVersion}. Reason: ${reason}`);
  res.json({ success: true, settings: updated });
});

// POST /api/control
app.post('/api/control', (req: Request, res: Response) => {
  const { action } = req.body;
  if (action === 'start') {
    resetSupervisorLock();
    startBotProcess();
    res.json({ success: true, status: botStatus, supervisor: getSupervisorDiagnostics() });
  } else if (action === 'stop') {
    stopBotProcess();
    res.json({ success: true, status: botStatus, supervisor: getSupervisorDiagnostics() });
  } else if (action === 'restart') {
    resetSupervisorLock();
    stopBotProcess();
    setTimeout(() => {
      startBotProcess();
    }, 1000);
    res.json({ success: true, status: 'starting', supervisor: getSupervisorDiagnostics() });
  } else if (action === 'simulate') {
    botStatus = 'simulated';
    addLog('info', 'Bot switched to Interactive Simulation Mode.');
    res.json({ success: true, status: botStatus, supervisor: getSupervisorDiagnostics() });
  } else {
    res.status(400).json({ error: 'Unknown action' });
  }
});

// POST /api/simulate - Interactive Facebook Chat message simulation
app.post('/api/simulate', async (req: Request, res: Response) => {
  const { message, senderName = 'Facebook User' } = req.body;
  const config = getBeatriceConfig();
  const prefix = config.prefix || '.';

  addLog('cmd', `[Simulated FB Event] "${senderName}": ${message}`);

  const parsed = parseCommandInput(message, prefix);
  let replyText = '';
  let audioBase64: string | null = null;

  if (parsed.isCommand) {
    const cmd = parsed.commandName;
    const args = parsed.args;

    switch (cmd) {
      case 'help': {
        const commands = getCommandsList();
        const categories = [...new Set(commands.map((c) => c.category))];
        let menu = `=== ✨ ${config.botName || 'Beatrice'} Command Menu ✨ ===\n`;
        menu += `Prefix: ${prefix}\nTotal Commands: ${commands.length}\n\n`;
        for (const cat of categories) {
          const catCmds = commands.filter((c) => c.category === cat).map((c) => c.name);
          menu += `[ ${cat.toUpperCase()} ] (${catCmds.length}):\n${catCmds.slice(0, 10).join(', ')}${catCmds.length > 10 ? '...' : ''}\n\n`;
        }
        menu += `Type "${prefix}help <command>" for detailed usage guide.`;
        replyText = toBeatriceFont(menu);
        break;
      }
      case 'uptime': {
        const uptimeSec = Math.floor(process.uptime());
        const reply = `🤖 ${config.botName || 'Beatrice'} System Uptime:\n• Uptime: ${formatUptime(uptimeSec)}\n• Status: Active & Operational\n• Node: ${process.version}\n• Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`;
        replyText = toBeatriceFont(reply);
        break;
      }
      case 'prefix': {
        replyText = toBeatriceFont(`Current Bot Prefix is: "${prefix}"`);
        break;
      }
      case 'info': {
        const reply = `🌟 ${config.botName || 'Beatrice bc'} 🌟\n• Author: sekro & Beatrice Team\n• Engine: FCA Unofficial / NoobCore\n• Mode: Active\n• Features: Multi-appstate, AI Baby persona, Group administration, 100+ commands.`;
        replyText = toBeatriceFont(reply);
        break;
      }
      case 'ping': {
        const randomPing = Math.floor(Math.random() * 60) + 40;
        replyText = toBeatriceFont(`🏓 Pong! Bot response latency: ${randomPing}ms`);
        break;
      }
      case 'coinflip': {
        const outcome = Math.random() > 0.5 ? 'Heads (صورة)' : 'Tails (كتابة)';
        replyText = toBeatriceFont(`🪙 Coin Flip Result: ${outcome}`);
        break;
      }
      case 'balance': {
        replyText = toBeatriceFont(`💳 Bank Balance for ${senderName}:\n• Wallet: $5,240\n• Bank: $12,500\n• Diamonds: 💎 14`);
        break;
      }
      case 'daily': {
        replyText = toBeatriceFont(`🎁 Daily reward claimed!\nYou received +$500 cash and +1 💎 Diamond.`);
        break;
      }
      case 'gemini':
      case 'ai':
      case 'bby':
      case 'baby':
      case 'beatrice':
      case 'بياتريس': {
        const prompt = args.join(' ').trim();
        const wantsAudio = req.body.voice || /--voice|--audio|صوت|تكلمي|فويس/i.test(prompt);
        const cleanPrompt = prompt.replace(/--voice|--audio/gi, '').trim();

        if (!cleanPrompt && (!req.body.images || req.body.images.length === 0)) {
          replyText = toBeatriceFont(`Please provide a question or attach an image. Example: bby how are you? ✨`);
        } else {
          try {
            const personaRes = await personaController.handleIncomingMessage({
              event: {
                threadID: 'sim_thread',
                senderID: senderName,
                senderName,
                body: cleanPrompt,
              },
              userMessage: cleanPrompt,
              images: req.body.images || [],
              isDirectMessage: true,
              wantsVoice: wantsAudio,
            });

            replyText = toBeatriceFont(personaRes.replyText || '...');

            if (personaRes.audioPath && fs.existsSync(personaRes.audioPath)) {
              const audioBytes = fs.readFileSync(personaRes.audioPath);
              audioBase64 = audioBytes.toString('base64');
            }
          } catch (aiErr: any) {
            replyText = toBeatriceFont(`⚠️ [Beatrice Persona]: ${aiErr.message || 'Unable to connect to Gemini API'}`);
          }
        }
        break;
      }
      default: {
        const allCmds = getCommandsList();
        const found = allCmds.find((c) => c.name.toLowerCase() === cmd);
        if (found) {
          const reply = `Command: ${prefix}${found.name}\nCategory: ${found.category}\nRole Level: ${found.role === 0 ? 'All Users' : 'Admin Only'}\nDescription: ${found.description}\nGuide: ${found.guide || 'Use ' + prefix + found.name}`;
          replyText = toBeatriceFont(reply);
        } else {
          replyText = toBeatriceFont(`❌ Command "${prefix}${cmd}" not found. Type "${prefix}help" for list of commands.`);
        }
        break;
      }
    }
  } else if (parsed.isNicknameTrigger) {
    // Companion AI persona (Betty / Beatrice) via PersonaController
    try {
      const wantsAudio = req.body.voice || /--voice|--audio|صوت|تكلمي/i.test(message);
      const personaRes = await personaController.handleIncomingMessage({
        event: {
          threadID: 'sim_thread',
          senderID: senderName,
          senderName,
          body: message,
        },
        userMessage: message,
        images: req.body.images || [],
        isDirectMessage: true,
        wantsVoice: wantsAudio,
      });

      replyText = toBeatriceFont(personaRes.replyText || '...');
      if (personaRes.audioPath && fs.existsSync(personaRes.audioPath)) {
        const audioBytes = fs.readFileSync(personaRes.audioPath);
        audioBase64 = audioBytes.toString('base64');
      }
    } catch {
      replyText = toBeatriceFont(`✨ Hey ${senderName}! Beatrice is here. What's on your mind? 🦦`);
    }
  } else {
    replyText = toBeatriceFont(`Received message: "${message}". Type "${prefix}help" to see available bot commands!`);
  }

  addLog('cmd', `[Bot Reply] -> "${replyText}"`);

  res.json({
    reply: replyText,
    isCommand: parsed.isCommand,
    commandName: parsed.commandName,
    rawText: replyText,
    audioBase64,
  });
});

// GET /api/file-view - view script file content
app.get('/api/file-view', (req: Request, res: Response) => {
  const reqPath = String(req.query.path || '');
  if (!reqPath || reqPath.includes('..')) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  const fullPath = path.join(BEATRICE_DIR, reqPath);
  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const code = fs.readFileSync(fullPath, 'utf-8');
    res.json({ path: reqPath, content: code });
  } catch (err: unknown) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// ================= System Setup & Doctor Routes =================

// GET /api/setup/doctor - run diagnostic check
app.get('/api/setup/doctor', async (_req: Request, res: Response) => {
  try {
    const report = await runSystemDoctor(__dirname);
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/setup/run - trigger setup run
app.post('/api/setup/run', async (req: Request, res: Response) => {
  try {
    const { downloadOnly, retry, voicesOnly } = req.body || {};
    const report = await runSetup(__dirname, { downloadOnly, retry, voicesOnly });
    res.json(report);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ================= Gemini Keys & Quota Management Routes =================

// GET /api/gemini/keys - list all registered keys (redacted)
app.get('/api/gemini/keys', (_req: Request, res: Response) => {
  const keys = geminiKeyManager.listKeys();
  res.json(keys);
});

// POST /api/gemini/keys - register new key
app.post('/api/gemini/keys', (req: Request, res: Response) => {
  try {
    const { alias, rawKey, ownerName, projectId, allowedModels, notes } = req.body;
    const entry = geminiKeyManager.addKey({
      alias,
      rawKey,
      ownerName,
      projectId,
      allowedModels,
      notes,
    });
    addLog('info', `Gemini Key registered: [${entry.alias}] (Project: ${entry.projectId || 'N/A'}, Mask: ${entry.maskedKey})`);
    res.json({ success: true, key: entry });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to add key' });
  }
});

// POST /api/gemini/keys/:id/rename
app.post('/api/gemini/keys/:id/rename', (req: Request, res: Response) => {
  try {
    const { newAlias, notes } = req.body;
    const updated = geminiKeyManager.renameKey(req.params.id, newAlias, notes);
    addLog('info', `Gemini Key [${req.params.id}] updated to alias: ${updated.alias}`);
    res.json({ success: true, key: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to rename key' });
  }
});

// POST /api/gemini/keys/:id/toggle
app.post('/api/gemini/keys/:id/toggle', (req: Request, res: Response) => {
  try {
    const { disabled } = req.body;
    const updated = geminiKeyManager.toggleDisableKey(req.params.id, !!disabled);
    addLog('info', `Gemini Key [${updated.alias}] status set to: ${updated.status}`);
    res.json({ success: true, key: updated });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to toggle key status' });
  }
});

// DELETE /api/gemini/keys/:id
app.delete('/api/gemini/keys/:id', (req: Request, res: Response) => {
  const ok = geminiKeyManager.deleteKey(req.params.id);
  if (ok) {
    addLog('warn', `Gemini Key [${req.params.id}] deleted from vault.`);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Key not found' });
  }
});

// POST /api/gemini/keys/:id/test - single light health check ping
app.post('/api/gemini/keys/:id/test', async (req: Request, res: Response) => {
  try {
    const result = await geminiKeyManager.testSingleKey(req.params.id);
    addLog(result.success ? 'info' : 'warn', `Health check for key [${req.params.id}]: ${result.status} (${result.latencyMs}ms)`);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Key test failed' });
  }
});

// POST /api/gemini/health-cycle - trigger 30-min scheduled health check
app.post('/api/gemini/health-cycle', async (_req: Request, res: Response) => {
  try {
    addLog('info', 'Triggering 30-minute Gemini Keys health check cycle...');
    const cycle = await geminiKeyManager.runHealthCheckCycle();
    addLog('info', `Health cycle [${cycle.cycleId}] complete. Tested ${cycle.testedCount} project/keys.`);
    res.json(cycle);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Health cycle execution failed' });
  }
});

// POST /api/gemini/chat - interactive multi-modal chat with vision & persona
app.post('/api/gemini/chat', async (req: Request, res: Response) => {
  try {
    const { message, threadId = 'sim_thread', senderId = 'sim_user', images = [], model = 'gemini-3.8-flash' } = req.body;
    const result = await executeGeminiChat({
      userMessage: message || '',
      threadId,
      senderId,
      images,
      model,
    });
    addLog('cmd', `[Gemini Chat] Model: ${result.model} | Key: ${result.usedKeyAlias} | Latency: ${result.latencyMs}ms`);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Gemini chat execution failed' });
  }
});

// ================= Kokoro-82M TTS Routes =================

// GET /api/tts/status - check Kokoro status and list voices
app.get('/api/tts/status', (_req: Request, res: Response) => {
  const health = kokoroTtsService.checkHealth();
  const voices = kokoroTtsService.getAvailableVoices();
  res.json({
    ...health,
    voices,
    defaultVoice: 'af_bella',
  });
});

// POST /api/tts/synthesize - synthesize audio with Kokoro / Gemini fallback
app.post('/api/tts/synthesize', async (req: Request, res: Response) => {
  try {
    const { text, voice = 'af_bella', speed = 1.0 } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required for TTS' });
    }

    const result = await kokoroTtsService.synthesize(text, { voice, speed });
    const audioBytes = fs.readFileSync(result.filePath);
    const base64Audio = audioBytes.toString('base64');

    addLog('info', `[TTS Synthesize] Generated ${result.engine} voice (${result.voice}, ${result.language}) in ${result.durationMs}ms`);

    res.json({
      success: true,
      engine: result.engine,
      voice: result.voice,
      language: result.language,
      durationMs: result.durationMs,
      fileSizeBytes: result.fileSizeBytes,
      audioBase64: base64Audio,
      mimeType: 'audio/wav',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'TTS synthesis failed' });
  }
});

// Vite middleware mounting
async function setupVite() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Beatrice-fca server running at http://0.0.0.0:${PORT}`);
  });
}

setupVite();
