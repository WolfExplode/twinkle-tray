// Centralized logger for the main process.
//
// Replaces the scattered `console.log` monkeypatching that used to live in
// electron.js. Provides leveled logging (debug/info/warn/error), ISO
// timestamps, a source tag, structured object output, and a rotating log file.
//
// Console output keeps ANSI colors; the file is always ANSI-stripped so it
// stays readable in a text viewer. Levels below the configured threshold are
// dropped from both sinks.
//
// Capture the real console methods at load time, before anything reassigns
// them, so the logger's own console output can never recurse through a patched
// global.
const realConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
}

const fs = require('fs')
const util = require('util')

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const ANSI = /\x1b\[[0-9;]*m/g

const config = {
  logPath: null,
  threshold: LEVELS.info,   // minimum level that gets logged at all
  consoleEnabled: false,    // whether to also print to the terminal
  maxBytes: 5 * 1024 * 1024 // rotate the active file once it passes this size
}

let stream = null
let writtenBytes = 0

// Move the current log aside to `*.prev.log` so a single previous session
// survives across launches (handy for crashes that happen right before a
// restart). Best-effort: any failure just means we start fresh.
function rotate(logPath) {
  try {
    if (fs.existsSync(logPath)) {
      const prev = logPath.replace(/\.log$/, '.prev.log')
      try { fs.rmSync(prev, { force: true }) } catch (e) { /* no prior prev */ }
      fs.renameSync(logPath, prev)
    }
  } catch (e) { /* best effort */ }
}

function openStream(logPath) {
  try {
    stream = fs.createWriteStream(logPath, { flags: 'a' })
    writtenBytes = 0
  } catch (e) {
    stream = null
  }
}

function init(opts = {}) {
  Object.assign(config, opts)
  if (config.logPath) {
    rotate(config.logPath)
    openStream(config.logPath)
  }
  return logger
}

// Strings pass through untouched (they may carry intentional ANSI for the
// console); everything else is inspected so objects/errors render usefully
// instead of "[object Object]".
function format(arg) {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack || arg.message
  return util.inspect(arg, { depth: 4, breakLength: 120 })
}

function write(level, args) {
  if (LEVELS[level] < config.threshold) return

  const ts = new Date().toISOString()
  const body = args.map(format).join(' ')
  const line = `${ts} [${level.toUpperCase()}] ${body}`

  if (config.consoleEnabled) {
    const fn = level === 'error' ? realConsole.error : (level === 'warn' ? realConsole.warn : realConsole.log)
    fn(line)
  }

  if (stream) {
    const clean = line.replace(ANSI, '') + '\r\n'
    try {
      stream.write(clean)
      writtenBytes += clean.length
      if (writtenBytes > config.maxBytes && config.logPath) {
        stream.end()
        rotate(config.logPath)
        openStream(config.logPath)
      }
    } catch (e) { /* never let logging throw */ }
  }
}

const logger = {
  init,
  debug: (...args) => write('debug', args),
  info: (...args) => write('info', args),
  warn: (...args) => write('warn', args),
  error: (...args) => write('error', args),
  // Receive an already-formatted log forwarded from another process
  // (renderer preload, forked child) and tag its source.
  fromRemote: (source, ...args) => write('info', [`[${source}]`, ...args])
}

module.exports = logger
