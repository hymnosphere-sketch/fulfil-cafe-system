# FE-09E — Synchronization status

The topbar, Dashboard, and Settings use the same read-only status model. The ordinary demo displays **Sync not configured**. Browser connectivity and local storage have their own indicators. The dashboard summary sits outside the stock calculations, and the Settings panel keeps its counts separate from the existing local demo queue count.

## Status evidence

- **Ready to sync** means a configured queue is empty. Pending and review counts come from persisted delivery and resolution states.
- **Synchronizing** reflects an explicit invocation in the current preview. A persisted pending row alone never indicates activity.
- **All changes synced** requires at least one confirmed operation and no outstanding work. A synchronized row must have a verified receipt for its operation, generation, and settings version. The latest valid receipt processing time is the last successful synchronization time.
- **Retry pending** shows the saved eligibility time. Refreshing after the deadline shows that a manual retry is eligible.
- **Sync could not finish**, **Sync needs review**, and **Recovery required** distinguish temporary failures, rejected operations, and pauses for recovery. Unknown or unreadable status is reported as unavailable. The UI uses safe messages and the saved queue counts.

## Development preview

Start Vite on loopback from `frontend/` and open `/tests/fe09e-preview.html`. Select **Create fictional queue** to prepare a disposable FE-09D queue. Choose an outcome and select **Run fixture sync** to exercise the real FE-09D engine with fictional responses. The fixture transport makes no API requests. **Refresh status** performs a read-only queue read and prioritizes the latest requested result. The queue name in the URL lets you reopen the same status after reload or a full Chrome restart with the same profile and origin.

The preview can also inspect a named disposable FE-09D queue. Fixture delivery is limited to the preview namespace and generation. The ordinary app has no link or startup hook for the preview, and the production build excludes it.

## Verification

Run `npm ci`, `node --test tests/*.test.js`, and `npm run build` from `frontend/`. To run `node tests/fe09e-status.browser.mjs`, start the Vite development server and production preview on isolated loopback ports, and start Chrome with a fresh profile and loopback debugging endpoint. Set `FE09E_APP_URL`, `FE09E_PRODUCTION_URL`, and `FE09E_CHROME_URL` to those endpoints. For restart verification, set `FE09E_EVIDENCE` to a temporary file path, run the test, exit Chrome fully, and relaunch the same profile. Update `FE09E_CHROME_URL` and run `node tests/fe09e-status.browser.mjs --verify-restart`. Keep the Vite origins unchanged.

Chrome checks cover portrait and landscape tablet widths, desktop layout, keyboard focus, accessible names, and warning contrast. Physical Android tablet acceptance remains a later workchart step.
