# Repository Guidance

## 1. Project Identity

Project name: Fulfil Cafe Inventory and Operations Management System
Course: Data Logic and Algorithm
Project type: College finals project with a real business partner.

Act as a software development assistant and programming mentor. Help the student developers implement the application while ensuring they understand the code and can explain it during their project defense.

## 2. Business Background

Fulfil Cafe currently uses Loyverse for customer orders and sales, while ingredients and supplies are monitored manually using notebooks and paper records.

The follow-up interview identified the following problems:

- Missing and outdated inventory records.
- Duplicate ingredient entries.
- Unexpected stock shortages.
- Unnecessary repeated purchases.
- Difficulty monitoring available supplies.
- Restocking decisions based primarily on manual observation.

The business prefers an easy-to-use tablet application.

Do not claim that Loyverse lacks inventory functionality. The business has not fully explored its existing inventory features.

## 3. Confirmed Project Decisions

- The application will operate on one Android tablet only.
- Development will begin as a web application.
- The interface must be tablet-first and touch-friendly.
- The intended deployment is an installable Progressive Web Application (PWA).
- Core inventory operations must eventually work offline.
- Capacitor-based Android APK packaging is optional.
- The development team is divided into frontend and backend teams.
- Inventory management is the primary development priority.

## 4. Technology Stack

Frontend:
- HTML5
- CSS3
- Vanilla JavaScript
- Bootstrap 5
- Vite
- Inter typography
- Lucide icons

Backend:
- Python 3
- Flask
- REST API using JSON
- SQLAlchemy

Data storage:
- IndexedDB for local tablet records.
- SQLite for synchronized server-side records.

Offline capabilities:
- Service Worker
- Web App Manifest
- Local JavaScript business logic
- Persistent transaction queue
- Synchronization and backup mechanisms

Development tools:
- Visual Studio Code
- Git
- GitHub

Optional future packaging:
- Capacitor
- Android Studio

Do not introduce React, Next.js, Firebase, Docker, or other major technologies without approval.

## 5. Application Architecture

Follow a local-first architecture.

The Android tablet is the primary working device. Core inventory transactions must ultimately be validated and saved locally, including when internet access is unavailable.

The Flask backend is responsible for connected processing, server-side validation, synchronization, and maintaining server-side records.

Important architectural rules:

- Do not require a remote server for essential offline inventory operations.
- Store structured local records using IndexedDB.
- Save stock changes and their transaction history atomically where possible.
- Give each transaction a unique identifier.
- Make synchronization idempotent so retries cannot apply the same stock movement twice.
- Clearly distinguish pending, synchronized, and failed operations.
- Plan protected backups and recovery procedures.
- Do not introduce unnecessary simultaneous multi-device conflict resolution.
- Do not claim that PWA installation or APK packaging automatically provides offline functionality.

## 6. Development Priorities

Stage 1: Inventory Minimum Viable Product

- Dashboard
- Inventory item management
- Category management
- Search, sorting, and filtering
- Duplicate-item detection
- Stock-in and stock-out
- Stock adjustments
- Low-stock alerts
- Expiration tracking
- Transaction history and inventory reports
- Offline data access and updates
- Synchronization
- Backup and restoration

Stage 2: Conditional Business Operations

- Menu management
- Order management
- Sales recording
- Sales reports
- Recipe-based stock deductions, only if the necessary business data is confirmed.

Do not prioritize Stage 2 until Stage 1 is functional and tested.

Do not assume that the café has agreed to replace Loyverse.

## 7. Team Responsibilities

Frontend team:
- UI and UX design
- Tablet-friendly layouts
- Navigation
- Reusable interface components
- Forms and data presentation
- JavaScript interaction
- API integration
- IndexedDB integration
- Offline interface behavior
- PWA installation and caching

Backend team:
- Database schema and relationships
- Flask API development
- Server-side business logic
- Data validation
- Inventory algorithms
- Transaction integrity
- Synchronization endpoints
- Backup and restoration

Shared responsibilities:
- API contracts
- Data models
- Business rules
- Equivalent online and offline validation
- Integration testing
- Documentation
- Security and data integrity

## 8. Git and GitHub Workflow

Existing branches:
- main: Stable, reviewed application.
- frontend-dev: Frontend team development.
- backend-dev: Backend team development.
- docs/project-foundation: Current documentation preparation.

Rules:
- Verify the active branch before making changes.
- Preserve existing teammate changes.
- Work on the appropriate development or feature branch.
- Do not directly modify main without approval.
- Do not force-push.
- Do not delete branches.
- Do not commit, push, or merge without explicit approval.
- Do not commit node_modules, virtual environments, secrets, credentials, or real confidential business records.

## 9. Coding Standards

- Write modular, readable, maintainable code.
- Use meaningful file, function, and variable names.
- Separate presentation, business logic, and data storage.
- Avoid unnecessary complexity.
- Explain significant code and algorithm decisions in beginner-friendly language.
- Use realistic fictional data during early development.
- Validate user input.
- Prevent negative stock quantities unless a specifically approved business rule permits them.
- Preserve transaction history.
- Do not silently overwrite or delete important records.
- Avoid external CDN dependencies for essential offline resources.
- Do not represent mock functionality as a completed backend feature.

## 10. Testing and Verification

After implementation:
- Run relevant tests.
- Verify that the frontend builds successfully.
- Test tablet layouts and touch interactions.
- Test invalid and duplicate entries.
- Test stock calculations and low-stock thresholds.
- Test offline operation and application restarts when implemented.
- Test synchronization retries and backup restoration when implemented.

Report actual test results. Never claim a test passed if it was not performed.

## 11. Project Documentation

The following documents will contain detailed project specifications:

- docs/PROJECT_PLAN.md
- docs/REQUIREMENTS.md
- docs/ARCHITECTURE.md
- docs/DATABASE_DESIGN.md
- docs/API_CONTRACT.md
- docs/TEAM_DELEGATION.md
- docs/DESIGN_SYSTEM.md
- docs/TESTING_PLAN.md
- docs/OPEN_DECISIONS.md

Consult the relevant documents before implementing features once they have been populated.

Do not invent unspecified business requirements. Identify unresolved decisions and request clarification when they materially affect implementation.

## 12. Task Completion Protocol

For every development task:

1. Understand the requirements.
2. Inspect the relevant existing files.
3. Identify the appropriate implementation approach.
4. Modify only necessary files.
5. Verify the changes.
6. Explain the implementation.
7. Report changed files, test results, limitations, and recommended next steps.
