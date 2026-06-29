# Twinkle Tray — Domain Glossary

## Canonical Settings
The single authoritative settings bundle for a monitor — what the user intentionally set (or what the active schedule set). Contains all controllable axes: DDC brightness, software dim level, color temperature (warmth), highlight compression, and any future per-monitor settings. All axes follow the same control hierarchy and flow through `BrightnessController`. Dim overlays (idle, inactive) apply only to the brightness axis on top of canonical; other axes are unaffected by overlays. Never reflects a dimmed or transient value.

## Brightness Control Hierarchy
Priority order, highest first:

1. **Schedule** — when a schedule is active, it owns canonical brightness. The tray UI blocks manual slider interaction by design.
2. **Manual Slider** — when no schedule is active, the user's slider input writes canonical brightness and cancels any active idle or inactive-monitor dimming.
3. **Idle Dimming** — applied on top of canonical brightness after system idle timeout. Cleared by any manual slider interaction.
4. **Inactive Monitor Dimming** — applied on top of canonical brightness when a monitor loses focus. Cleared by any manual slider interaction on that monitor.

## Commanded Brightness
The value sent to hardware or software dim layer at any given moment. Equals canonical brightness unless idle dimming or inactive-monitor dimming is active. Shown as the orange slider value and system tray brightness. `commandedBrightness = canonical − dimOffset`.

## Optimistic Rendering
The renderer (BrightnessPanel, Slider) updates its local display state immediately when the user moves a slider, without waiting for main-process confirmation. This avoids visible lag caused by the IPC round-trip (~16–50ms) plus the DDC command latency (~50–200ms per monitor). Without optimistic rendering, the slider would visibly rubber-band or stutter on every input event. The renderer's local display state is considered ephemeral — it is always overwritten by the next `monitors-updated` event from main. The renderer never sends its local state back to main as canonical truth; IPC carries only user intent (e.g. "user moved monitor X to value Y").

## Ghost Marker
A secondary position indicator on the tray slider shown when commanded brightness is below canonical due to an active dimming overlay (idle or inactive-monitor). Displays canonical brightness so the user can see their "real" setting. The marker label indicates which overlay is responsible ("overridden by idle" or "overridden by inactive monitor"). Currently only implemented for inactive-monitor dimming — idle dimming ghost marker is a known missing feature.

## Monitor
A logical display entry tracked by Twinkle Tray, identified by hardware ID. Carries canonical brightness, DDC capability flags, and software dim state.

## DDC/CI
Hardware protocol for setting physical monitor brightness. Asynchronous — commands go to a worker thread; confirmation comes only via the next `refreshMonitors` poll. DDC commands are serialized per monitor with a depth-1 pending queue: if a new value arrives while a command is in-flight, the in-flight command completes and only the latest pending value is sent next. Stale intermediate values are dropped.

## Concurrency Model
The Electron main process is single-threaded — there are no true thread races in JavaScript. The actual hazards are:
1. **Event interleaving** — IPC handlers, timer callbacks, and WMI event handlers all run on the same event loop. A handler that runs multiple async steps can be interleaved by another handler between those steps.
2. **Out-of-order async completions** — DDC commands execute in a worker thread and may complete in a different order than they were sent.
3. **Timer/IPC interleaving** — `setInterval` transition loops (running at ~16ms) interleave with IPC handlers from user input.

Because JS is single-threaded, no mutex is needed for reads/writes to in-memory state. The solution is a `BrightnessController` that acts as the single synchronous gatekeeper — all writes to canonical brightness and all DDC dispatch go through it, preventing interleaving by keeping each write path as a single synchronous step.

## Software Dim
A separate overlay (e.g. color filter or opacity layer) applied in addition to DDC brightness. Tracked independently per monitor. Part of commanded brightness calculation.

## refreshMonitors
A polling operation that reads current hardware state and updates the in-memory monitor map. Responsible for detecting monitor connection/disconnection and DDC capability changes. Must not overwrite canonical brightness after startup — brightness authority belongs to the control hierarchy, not the poller.

## Startup Brightness Initialization
On launch, canonical brightness is loaded from persisted settings (immediate, no flicker). The first `refreshMonitors` hardware poll then reconciles — if hardware reports a different value, canonical updates to match. After initialization is complete, `refreshMonitors` never writes canonical brightness again.

## WMI Brightness Event
A Windows event fired when monitor brightness changes externally (physical OSD buttons, ambient light sensor, OS auto-brightness). Treated as equivalent to manual slider input: writes canonical brightness for the affected monitor. The current `ignoreBrightnessEventTimeout` suppression pattern is a known race condition and will be removed.

## Idle Dimming
A dimming mode that reduces brightness after the system has been idle for a configured duration. Applies as a dim offset — does not write canonical brightness. Commanded brightness drops; ghost marker shows canonical. Resets on any manual user input (slider move), restoring commanded to canonical. Ghost marker for idle dimming is a known missing feature in the current UI.

## Inactive Monitor Dimming
A dimming mode that reduces brightness on monitors not currently in focus. Resets on any manual user input targeting that monitor.

## Schedule
A time-based brightness profile. When active, it is the sole writer of canonical brightness and the UI prevents manual overrides. When disabled, canonical brightness remains at whatever value the schedule last set — it does not revert to a pre-schedule snapshot.
