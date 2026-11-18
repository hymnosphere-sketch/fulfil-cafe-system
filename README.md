# Fulfil Cafe Inventory and Operations Management System

Fulfil Cafe uses Loyverse for checkout and sales recording and tracks ingredients and supplies largely in notebooks and paper lists. Staff reported missing, outdated, and duplicate inventory entries, unexpected shortages, and purchases repeated because existing stock was overlooked. This Data Logic and Algorithm finals project aims to make inventory easier to find, update, and verify during everyday café operations.

## Project goals and scope

The project will digitize ingredient and supply records, organize them by category, flag possible duplicates, and make current balances and restocking needs easier to see. A recorded stock movement explains each change in quantity. Search, sorting, filtering, and reports help staff find and understand those records.

- **Stage 1 — Inventory MVP.** Build the dashboard, item and category management, stock-in, stock-out, wastage and adjustments, low-stock and expiration alerts, transaction history, and inventory reports. Support essential offline workflows, synchronization, and backup and recovery.
- **Stage 2 — Conditional expansion.** Consider menu management, orders, sales recording, sales reports, and recipe-based stock deductions after the inventory MVP is functional and tested and the relevant business rules are approved. Loyverse replacement remains a separate decision.

The first planned demonstration uses fictional data to receive 20 units, record usage of 5, and show a balance of 15 after reopening the app. It also checks that retrying an accepted sync operation leaves the balance at 15. See the [Project Plan](docs/PROJECT_PLAN.md#first-functional-vertical-slice).

## Planned architecture and technology

The app is designed for a single Android tablet. The tablet validates and saves essential inventory work in IndexedDB first, then sends queued changes to Flask when connected. Flask validates the changes again and stores synchronized records in SQLite. A Service Worker will cache the files needed to open the app offline, and a Web App Manifest will support installation as a Progressive Web App (PWA). The tablet needs a connection for initial setup. The intended layout follows the approved Modern Café design, with touch-friendly controls, landscape-first layouts, and portrait support.

| Area | Approved stack |
|---|---|
| Frontend | HTML5, CSS3, vanilla JavaScript, Bootstrap 5, Vite, Inter typography, and Lucide icons |
| Tablet storage and offline operation | IndexedDB, Service Worker, and Web App Manifest |
| Backend | Python 3, Flask, JSON REST API, SQLAlchemy, and SQLite |
| Collaboration | Git, GitHub, and Visual Studio Code |
| Optional Android packaging | Capacitor and Android Studio, if approved later |

## Current implementation status

The repository contains a **Vite starter** with the sample counter and assets. The Fulfil Cafe screens, inventory workflows, offline storage, and synchronization are planned. Bootstrap, Inter, and Lucide are absent from the current frontend dependency list and will be added during a later approved task. The backend has yet to be initialized, and the API contract describes planned endpoints. All 75 planned application test cases are marked **Not Run**.

```text
fulfil-cafe-system/
├── AGENTS.md             Project and repository guidance
├── README.md             Developer onboarding
├── docs/                 Approved project planning documents
└── frontend/
    ├── index.html        Vite entry page
    ├── package.json      Scripts and declared dependencies
    ├── package-lock.json Locked package versions
    ├── public/           Static assets
    └── src/              Vite starter JavaScript, styles, and assets
```

## Get started

### 1. Prepare your tools

- Install Git and use a GitHub account with access to the repository. Verify your commit identity, including your GitHub no-reply address if you keep your email private.
- Install Node.js and npm for frontend work. Node.js 22.12 or newer meets the requirement recorded for Vite in the current lockfile.
- Use Visual Studio Code or an editor your team supports, plus a modern browser for local frontend checks.
- Backend developers should have Python 3 available. The Android tablet is needed for later device verification. Android Studio is only needed if the team chooses optional APK packaging.

### 2. Clone the repository

Open a terminal in the folder where you keep your projects and run the commands below. A clone downloads the repository and records GitHub as the remote named `origin`. If you already have a clone, open it and skip this step.

```sh
git clone https://github.com/hymnosphere-sketch/fulfil-cafe-system.git
cd fulfil-cafe-system
git fetch origin
```

### 3. Choose your development branch

| Branch | Purpose |
|---|---|
| `main` | Stable, reviewed project |
| `frontend-dev` | Shared frontend development |
| `backend-dev` | Shared backend development |

Run `git status` and make sure the working tree is clean before switching branches or starting a new task. If you have unfinished changes, preserve them on their current task branch and coordinate before continuing. Fetch before starting each task, select your team's branch, and use `--ff-only` to update it. A fast-forward advances the branch to GitHub's commit when its history already lines up. Before creating the feature branch, run `git status --short --branch` and confirm the development branch matches its upstream. If Git refuses the update or the local branch is still ahead, stop and review the histories with your team.

For frontend work, run the following from the repository root.

```sh
git fetch origin
git switch frontend-dev
git merge --ff-only origin/frontend-dev
git status --short --branch
git switch -c frontend/inventory-layout
```

For backend work, use the backend branch instead.

```sh
git fetch origin
git switch backend-dev
git merge --ff-only origin/backend-dev
git status --short --branch
git switch -c backend/database-models
```

Git normally creates a local tracking branch when you first switch to a branch that only exists on `origin`. If needed, use `git switch --track origin/frontend-dev` or `git switch --track origin/backend-dev` for that first checkout. Replace the example feature branch name with a short, lowercase, hyphenated name for your assigned task. Use `frontend/<task>` or `backend/<task>` to show which team owns it.

### 4. Run the existing frontend

From the repository root, run the following on your frontend feature branch. `npm ci` installs the versions listed in the lockfile into the ignored `node_modules` folder. `npm run dev` starts Vite. Open the local address Vite prints to see the starter page. Press Ctrl+C to stop the server.

```sh
cd frontend
npm ci
npm run dev
```

| Command from `frontend/` | Purpose |
|---|---|
| `npm run build` | Build the frontend for production. |
| `npm run preview` | Preview that build locally after running `npm run build`. |

On Windows, if PowerShell blocks the `npm.ps1` wrapper, use `npm.cmd ci` and `npm.cmd run dev`. Use the same `npm.cmd` substitution for build and preview.

### 5. Prepare for backend work

Run `python --version` to check that Python 3 is available. On Windows, `py -3 --version` is an alternative if the Python launcher is installed. Read the [Architecture](docs/ARCHITECTURE.md#5-proposed-project-structure), [Database Design](docs/DATABASE_DESIGN.md), and [API Contract](docs/API_CONTRACT.md) before your first backend task. The approved backend foundation task will establish the project folder, isolated Python environment, dependency list, and run instructions. There is currently no Flask server to start or repository-defined backend dependency list to install.

## Collaborate on a feature

1. **Confirm the task.** Check the work package and its dependencies. Discuss changes to shared data models, API fields, or business rules with both teams before implementing them.
2. **Work on your feature branch.** Keep changes focused and preserve existing teammate work. Use fictional data for examples and tests.
3. **Test and review locally.** Run checks that apply to the task, inspect `git status` and `git diff`, and stage only relevant files. Record actual results and any checks you could not run.
4. **Commit and publish with approval.** Write a short message that describes one change. After approval, publish a new feature branch with `git push -u origin HEAD`. This creates a tracking link so Git knows which remote branch corresponds to your local branch.
5. **Open a pull request.** Target `frontend-dev` for frontend work or `backend-dev` for backend work. Include the work package ID, a change summary, testing evidence, and known limitations. Add screenshots for interface changes where helpful.
6. **Get a teammate review.** Reviewers check the implementation, shared contracts, data handling, and tests. Resolve feedback and discuss conflicts with the affected teammate. Merge after review, relevant checks, and explicit approval. Keep `main` for reviewed integration and avoid force-pushes, branch deletion, or overwriting teammate changes.

Example commit messages for future tasks are shown below.

```text
feat(frontend): add inventory list layout
feat(backend): add category validation
fix(frontend): retain form input after validation
docs: clarify the stock adjustment workflow
```

Keep passwords, API keys, credentials, real café records, and customer or staff information out of the repository, pull requests, screenshots, and test fixtures. Use clearly labeled fictional records for development. Keep generated dependencies, Python virtual environments, and local secret settings out of commits.

## Project documentation

| Document | What to read it for |
|---|---|
| [Repository guidance](AGENTS.md) | Project rules, coding standards, and verification expectations |
| [Project Plan](docs/PROJECT_PLAN.md) | Business context, scope, and first demonstration |
| [Requirements](docs/REQUIREMENTS.md) | Feature requirements, acceptance criteria, and traceability |
| [Architecture](docs/ARCHITECTURE.md) | Tablet, server, offline, and recovery design |
| [Database Design](docs/DATABASE_DESIGN.md) | Entities, quantities, stock movements, and algorithms |
| [API Contract](docs/API_CONTRACT.md) | Proposed requests, responses, and sync rules |
| [Team Delegation](docs/TEAM_DELEGATION.md) | Work packages, handoffs, and Git workflow |
| [Design System](docs/DESIGN_SYSTEM.md) | Modern Café styles, components, and tablet layouts |
| [Testing Plan](docs/TESTING_PLAN.md) | Planned tests and release criteria |
| [Open Decisions](docs/OPEN_DECISIONS.md) | Pending approvals, owners, and what each decision blocks |

## Outstanding decisions

The café still needs to confirm inventory units and precision, purchase pricing, batch selection, stock and expiration rules, staff permissions, and offline access policy. Hosting, backup retention, and recovery authorization also remain open. The team can start the frontend foundation using fictional data while these decisions are tracked and confirmed. Check [Open Decisions](docs/OPEN_DECISIONS.md) before implementing rules that depend on them.
