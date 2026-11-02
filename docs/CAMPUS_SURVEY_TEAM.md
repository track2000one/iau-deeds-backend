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
