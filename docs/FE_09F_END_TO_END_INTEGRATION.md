# FE-09F — Isolated end-to-end inventory

FE-09F uses the ordinary Fulfil Cafe workspaces with a separate test database. Each local inventory save also appends its validated API v2 command in the same IndexedDB transaction. The saved command keeps its operation UUID, original payload, and sequence. On demand, the FE-09D engine delivers these commands in order under its existing Web Lock. An acknowledgment changes delivery state in the queue. It does not apply stock a second time.

## Run the fictional workflow

1. Export the agreed `backend-dev` revision `9d4af373764dd88896bf0988fc2c4fed7a7856af` to a disposable directory. Install that export’s `backend/requirements.txt` in a temporary Python environment.
2. From `frontend/`, run `npm ci` and `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort`.
3. In another terminal from `frontend/`, use the temporary environment’s Python to run `python tests/fe09f-flask.py <absolute-exported-backend-directory> http://127.0.0.1:5173`. The launcher prints a loopback URL and gives Flask a new temporary SQLite file. Keep the launcher running.
4. Open `http://127.0.0.1:5173/tests/fe09f-integration.html`. Enter the printed Flask port and select **Initialize fictional inventory**. The topbar shows **Integration Test · Fictional Data**.
5. In **Categories**, add a fictional category. In **Inventory**, add a fictional item in that category and select **piece**. Set a minimum stock level of 16 to also see a low-stock alert after withdrawal.
6. Open **Stock**, choose **Receive stock**, select the item, enter 20, and confirm the review. Choose **Record usage**, enter 5, assign 5 to the received batch, and confirm. Inventory shows 15 and History lists both movements. The four operations are saved locally.
7. In **Settings**, select **Synchronize now**. The panel shows four confirmed operations after Flask acknowledges them. Check that Inventory still shows 15. The Dashboard summary and topbar reflect the same queue.
8. Save the integration page URL and reopen it after restarting Chrome with the same profile and Vite origin. The URL selects the saved fixture. The app opens from IndexedDB without requesting another snapshot. Manual sync requires the paired disposable Flask instance. Press Enter in the Flask terminal when finished to close and remove the temporary SQLite file.

The integration entry point is available only in Vite development mode on loopback. It accepts a port, and the v2 transport requires the disposable server’s fixture marker. The ordinary seven routes use the demo database. The production build has no integration entry point or fixture transport.

## Data and delivery boundaries

- Initialization validates the real v2 response with the FE-09C client, including header agreement, replay integrity, and commit order. Only an authoritative snapshot can seed a new integration database. The initial rows and their generation, settings, starting commit position, and Flask origin publish in one transaction. Reopening reads the existing dataset and never replaces unsynchronized work.
- All workspaces use the same integration repository. Stock and batch balances derive from movements and allocations. API `piece` quantities display as pieces. API `kg` and `l` quantities use scale three, so the UI displays and accepts exact integer grams and millilitres. The server settings and the initialization snapshot’s business date govern the fictional calendar displays.
- FE-09D checks generation, settings, and verified server history before the first send. The queue keeps failed operations for review and leaves uncertain delivery pending under its original identity. The shared FE-09E model displays local records and verified acknowledgments. Eligibility timers update the Settings button only.
- FE-09G revalidates saved receipts against the original commands, generation, settings version, and commit order. Conflicting evidence makes synchronization status unavailable and stops delivery. Inventory remains available locally. An older retry count saved as `NaN` is read as at least one previous failure and corrected on the next delivery update.
- Browser connectivity is shown separately. Local work remains available when Flask is unreachable. Supervised repair, production synchronization, physical Android acceptance, and background sync are later work.

## Verification

From `frontend/`, run `npm ci`, `node --test tests/*.test.js`, and `npm run build`. Then set `FE09F_CHROME_BIN` to the Chrome executable, `FE09F_BACKEND_ROOT` to the pinned disposable backend directory containing `app/`, and `FE09F_PYTHON` to the temporary Python executable. Run `node tests/fe09f-integration.browser.mjs`. It launches its own loopback Vite and Flask servers, production preview, and fresh Chrome profile. The restart test closes Chrome and reopens the same profile and integration origin.

The core test compares the local and server catalog, batch, movement and allocation records as well as verified receipt identities and balances. Other tests exercise a rolled-back local transaction, an invalid withdrawal, disconnected local use, a lost reply after a real Flask commit, a real business rejection, generation mismatch, invalid initialization, and ordinary demo isolation.
