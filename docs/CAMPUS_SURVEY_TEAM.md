# Campus survey team — staged implementation plan

## Approved allocation
- WEST — عبدالرحمن مسفر القحطاني — الحرم الغربي.
- RAYYAN — حسين علي الدبوس — كلية الريان.
- EAST — بدر خالد الهاجري — الحرم الشرقي.
- LEAD — محمد المغربي — overall supervision, reports, and follow-up.

Private houses outside the Western Campus are NOT university property and must not be registered as university holdings.

## Included in this draft
- Additive Prisma model `SurveyTeamAssignment` with stable codes, account binding, status, notes, and timestamps.
- Protected `/api/campus-survey-team` endpoints for initialization, viewing, manager updates, account discovery, and provisional counts.
- Initialization is administrator-triggered and idempotent. It does not guess user accounts from names.
- The leader can review all assignments and update status/notes **only after their real account has been bound by an admin**.
- Team members can only read their own assignment within this API, once their accounts are bound.
- Manual SQL for the dedicated new table only; no existing records modified.

## Important limitations — before field operations
- This draft does **not** yet enforce per-campus row-level access in existing `/api/mosques/buildings`, `/api/site-inspections`, or `/api/vacant-lands` endpoints.
- The new frontend `survey_team` permission controls the navigation entry and is separate from server-side team membership. Assign it to the intended staff explicitly.
- Counts are provisional aggregates of pre-existing records matched by campus text. They are not survey completion statistics; inspection counts include only inspections linked to a building.
- `VacantLand` table may still be missing. The metrics endpoint reports vacant-land counts as null in that case. Its schema must be validated in staging before data-entry rollout.
- Geographic boundaries/KML and actual deed ownership remain to be verified before marking a campus complete.

## Safe verification sequence
1. Confirm staging database, verify backup and restore readiness.
2. Create only the new team table using the targeted SQL or reviewed Prisma schema deployment in staging.
3. Build backend and frontend from their corresponding feature branches.
4. Sign in as admin and POST `/api/campus-survey-team/setup` once.
5. Bind the four staff accounts using actual IDs, then grant only needed module permissions.
6. Verify a team member cannot fetch another member's assignment by API.
7. Verify supervisor sees all four members, can review statuses, and cannot bind other accounts unless admin.
8. Confirm provisional counts and VacantLand missing-table behavior.
9. Implement and test per-campus authorization at the three existing data endpoints BEFORE allowing field staff to modify live data.
10. Do not deploy to Production or merge without explicit authorization.

This feature branch is intentionally a **draft, not production-ready**.

## Unified field-inspections experience
- No duplicate survey-team item in the main navigation: staff supervision is a tab inside **المعاينات الميدانية**.
- Inspection table reports now show the authenticated creator username on every row, support filtering by creator, and include a staff activity summary with detailed site visits, observations, and recommended actions.
- Individual inspection reports distinguish **the user who entered the record** (`createdBy`) from **the person who performed the inspection** (`inspectorName`).
- The supervision tab shows separate **per-account work counts** and **campus-wide reference totals**.
- The read-only `GET /api/campus-survey-team/work-report/:code` returns building, vacant-land, and inspection records attributable to the selected linked account; leader/admin can see staff summaries, members only their own.
- Pre-existing inspections store usernames rather than stable account IDs. Renamed usernames and unlinked inspections require manual attribution/scope review. Counts and reports are not formal completeness verification.

## Central building registry: mandatory founding fields for assigned team members
- Team member accounts must establish buildings in the **existing** `السجل المركزي للمباني` (not a duplicate registry).
- Required for staff-created/edited records: building code, building/site name, district, assigned campus, latitude, longitude, and an integer number of floors >= 1; the existing deed-link requirement is preserved.
- Campus is resolved from the active authenticated assignment; the browser displays it read-only, and the API rejects cross-campus create/update even if a request is tampered with.
- Staff building listing, photo access, and edits are scoped to the assigned campus; bulk/single building delete is blocked for team members.
- Creator remains linked to the authenticated account ID for reliable user activity reporting.
- No automatic changes to old building records, and general non-team building flows retain their historical input rules.
- Unit tests added: `tests/survey-building-scope.test.js` (not run in this conversation).
- **Important unresolved boundary:** campus string and coordinate validity do not prove that a building sits inside university property. Verify official deed and GIS polygon/KML campus boundaries; private residences outside West Campus are explicitly excluded.
- **Important deployment dependency:** the new survey team table must exist and each account be linked before granting editing rights. Tests and migration must run in Staging first.
