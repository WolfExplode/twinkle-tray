#!/usr/bin/env node
'use strict'
// Debug CLI for Twinkle Tray idle/schedule interaction.
// Requires the app to be running with: npm run dev
// The dev flag starts a debug HTTP server on port 13579.
//
// Usage:
//   node scripts/debug-cli.js state
//   node scripts/debug-cli.js watch [intervalMs]
//   node scripts/debug-cli.js idle <seconds>
//   node scripts/debug-cli.js wake
//   node scripts/debug-cli.js clear
//   node scripts/debug-cli.js apply-schedule [force=true|false]

const http = require('http')

const PORT = 13579
const HOST = '127.0.0.1'

function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: HOST, port: PORT, path, method }, res => {
      let body = ''
      res.on('data', d => body += d)
      res.on('end', () => {
        try { resolve(JSON.parse(body)) } catch { resolve(body) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function fmtState(data) {
  const ts = new Date().toISOString().slice(11, 23)
  const { idle, schedule, debugIdleTimeOverride, notIdleMonitorActive } = data
  const lastEventVal = schedule?.lastTimeEvent?.value
  const lastEventTime = lastEventVal != null
    ? `${Math.floor(lastEventVal / 60)}:${String(lastEventVal % 60).padStart(2, '0')}`
    : 'none'
  const overrideStr = debugIdleTimeOverride !== null ? `${debugIdleTimeOverride}s (OVERRIDE)` : 'real'
  return [
    `[${ts}]`,
    `isUserIdle=${idle?.isUserIdle}`,
    `userIdleDimmed=${idle?.userIdleDimmed}`,
    `lastIdleTime=${idle?.lastIdleTime}s`,
    `shortMonitor=${notIdleMonitorActive}`,
    `lastScheduleEvent=${lastEventTime}`,
    `idleOverride=${overrideStr}`,
  ].join('  ')
}

async function main() {
  const [,, cmd, ...args] = process.argv

  switch (cmd) {
    case 'state': {
      const data = await request('GET', '/debug/state')
      console.log(JSON.stringify(data, null, 2))
      break
    }

    case 'watch': {
      const interval = parseInt(args[0] ?? '2000')
      console.log(`Watching state every ${interval}ms — Ctrl+C to stop\n`)
      const tick = async () => {
        try {
          const data = await request('GET', '/debug/state')
          console.log(fmtState(data))
        } catch (e) {
          console.error(`[${new Date().toISOString().slice(11,23)}] connection error: ${e.message}`)
        }
      }
      await tick()
      setInterval(tick, interval)
      break
    }

    case 'idle': {
      const seconds = parseInt(args[0] ?? '300')
      if (isNaN(seconds)) { console.error('idle requires a number of seconds'); process.exit(1) }
      await request('POST', `/debug/idle?seconds=${seconds}`)
      console.log(`Forced idle time → ${seconds}s. App will detect idle and dim after ~1s tick.`)
      break
    }

    case 'wake': {
      await request('POST', '/debug/wake')
      console.log('Forced idle time → 0s. App should detect wake within 1s.')
      break
    }

    case 'clear': {
      await request('POST', '/debug/clear-override')
      console.log('Idle time override cleared. Using real powerMonitor.getSystemIdleTime().')
      break
    }

    case 'apply-schedule': {
      const force = args[0] !== 'false'
      const data = await request('POST', `/debug/apply-schedule?force=${force}`)
      console.log('apply-schedule result:')
      console.log(JSON.stringify(data, null, 2))
      break
    }

    // Scenario: simulate full idle→dim→wake cycle automatically
    case 'sim-idle-wake': {
      const idleSecs = parseInt(args[0] ?? '400')
      const stepMs = 500

      console.log(`Simulating idle→dim→wake with idle=${idleSecs}s\n`)

      // Ramp up idle time above threshold
      console.log(`Step 1: setting idle time to ${idleSecs}s`)
      await request('POST', `/debug/idle?seconds=${idleSecs}`)

      // Wait for short monitor to trigger and dim (~6s: 5s long check + 1s short check)
      console.log('Waiting 7s for idle detection loop to dim displays...')
      let elapsed = 0
      const watchHandle = setInterval(async () => {
        try {
          const data = await request('GET', '/debug/state')
          elapsed += stepMs
          process.stdout.write(`\r  ${fmtState(data)}  [${elapsed}ms]`)
        } catch {}
      }, stepMs)

      await new Promise(r => setTimeout(r, 7000))
      clearInterval(watchHandle)
      console.log('\n')

      const dimState = await request('GET', '/debug/state')
      console.log(`After idle: userIdleDimmed=${dimState.idle?.userIdleDimmed}`)

      // Simulate wake
      console.log('\nStep 2: simulating wake (idle → 0s)')
      await request('POST', '/debug/wake')

      console.log('Waiting 8s for wake + restore sequence...')
      let elapsed2 = 0
      const watchHandle2 = setInterval(async () => {
        try {
          const data = await request('GET', '/debug/state')
          elapsed2 += stepMs
          process.stdout.write(`\r  ${fmtState(data)}  [${elapsed2}ms]`)
        } catch {}
      }, stepMs)

      await new Promise(r => setTimeout(r, 8000))
      clearInterval(watchHandle2)
      console.log('\n')

      const wakeState = await request('GET', '/debug/state')
      console.log(`After wake: userIdleDimmed=${wakeState.idle?.userIdleDimmed} lastScheduleEvent=${wakeState.schedule?.lastTimeEvent?.value ?? 'none'}`)

      // Clear override
      await request('POST', '/debug/clear-override')
      console.log('\nOverride cleared.')
      break
    }

    default:
      console.log(`Twinkle Tray debug CLI
Requires: npm run dev (starts debug server on port ${PORT})

Commands:
  state                      Dump full app state as JSON
  watch [intervalMs]         Poll and log state (default: 2000ms)
  idle <seconds>             Force idle time to N seconds
  wake                       Force idle time to 0 (simulate user returning)
  clear                      Clear override, use real powerMonitor
  apply-schedule [force]     Call applyCurrentAdjustmentEvent (force=true default)
  sim-idle-wake [idleSecs]   Automated idle→dim→wake scenario (default: 400s idle)`)
  }
}

main().catch(err => {
  if (err.code === 'ECONNREFUSED') {
    console.error(`Cannot connect on port ${PORT}. Run: npm run dev`)
  } else {
    console.error(err)
  }
  process.exit(1)
})
