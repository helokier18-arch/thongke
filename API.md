# MySQL API

This API stores version 3 application state and monthly vessel statistics in MySQL/MariaDB. The browser also keeps a local copy for recovery.

## Requirements

- Node.js 20 or later
- XAMPP MySQL/MariaDB or another MySQL-compatible server

## Run locally on Windows

1. Install Node.js 20 or later and start **MySQL** in the XAMPP Control Panel.
2. In MongoDB Atlas, open the cluster and:
   - Add a database user under **Security → Database Access**. Use a dedicated username and password; do not use an Atlas account password.
   - Add your current IP address under **Security → Network Access**. Avoid allowing access from `0.0.0.0/0`.
   - Choose **Connect → Drivers → Node.js** and copy the connection string.
3. Copy `.env.example` to `.env`. Set `MONGODB_URI` to the copied connection string, replace its password placeholder with the database user's password, and set the database name to `maritime_statistics`. URL-encode special characters in the password. Keep `.env` private; it is excluded by `.gitignore`.
4. Keep `API_PORT=3000`. The API serves `main.html` and the separate `monthly-formulas.js` calculation engine from the same origin, so the browser does not need cross-origin access.
5. In PowerShell, from this directory, run:

   ```powershell
   npm install
   npm start
   ```

   The server loads values from `.env`; environment variables already set in PowerShell take precedence.

6. Open `http://127.0.0.1:3000/api/health` to check that the API can reach Atlas, then use the app at `http://127.0.0.1:3000/`. Do not open `main.html` directly as a file if you want MongoDB synchronization.

The API binds to `127.0.0.1` by default. Binding to a public interface requires `API_AUTH_USERNAME` and `API_AUTH_PASSWORD`; the app and API then use HTTP Basic authentication, which Render delivers over HTTPS. Never put the MongoDB URI, database password, or web login password in `main.html` or Git. The test deployment is for controlled testing only, not production identity/access management.

The latest full application-state and monthly dataset snapshot is stored locally in `database-backup.json` in this directory. The file is refreshed only after MongoDB confirms the save and is excluded from Git. Copy it to separate secure storage periodically for protection against disk loss; a backup in the same folder is not protection against failure of that disk.

## Vessel areas and legacy data

Vessel records remain in the existing version 3 `applicationState` document and its monthly `datasets` snapshots. Each new or imported vessel has a `khuVuc` value from the six fixed areas: `Cửa Việt`, `Cồn Cỏ`, `Hòn La`, `Cửa Gianh`, `Mỹ Thủy`, or `Lèn Bảng`. The server validates the value and creates a MongoDB index on `data.vessels.khuVuc`. “Tổng hợp” is a view across those areas, not a stored area.

Computed statistical report forms use the selected area's records for both the report month and year-to-date figures; “Tổng hợp” uses all areas. Workbook-wide plans and historical totals are not assigned to a specific area and are omitted from area-specific reports. The imported “Bảng màu tháng” remains the original workbook view, not a per-area calculation.

The “Kỳ đang xem” selector remembers a period separately for each sidebar area and, on the reports tab, for each report-area selection. Its options and vessel counts are scoped to that area; “Tổng hợp” has its own selection in each context.

Existing records without `khuVuc` are not changed automatically on server startup. Review their assignments with the migration's read-only dry run:

```powershell
npm run migrate:regions:check
```

The report includes a stable `legacyKey` for each unresolved record. After reviewing the inferred areas and deciding the remaining assignments, create a private JSON file mapping each unresolved key to one of the six exact area names. Apply only after confirming the report and mappings:

```powershell
npm run migrate:regions:apply -- --assignments .\region-assignments.json
```

When the dry run has no unresolved records, `--assignments` can be omitted. The migration is safe to rerun, does not delete vessels, and refreshes the normal database backup after a successful write. Do not share the mapping file if it contains operational vessel data.

## Move existing browser data to MongoDB

Browser storage for a `file://` page is separate from storage for the HTTP app. Before switching from the old local-file page:

1. Open the existing `main.html` file and click **Tải dữ liệu JS** to download a backup of all periods.
2. Open `http://127.0.0.1:3000/` and click **Nhập dữ liệu JS**.
3. Select the downloaded backup and confirm replacement. The app saves it locally and synchronizes it to MongoDB; wait for the **MongoDB: Atlas + backup đã lưu** status.

After migration, open the app using the localhost URL while the API is running. Do not open the HTML file directly when expecting synchronization.

## Deploy a test version to Render

1. Push this project to a private GitHub repository. Do not include `.env`, `database-backup.json`, or `node_modules`.
2. In Render, choose **New → Blueprint** and connect the repository containing `render.yaml`.
3. Set the requested secret environment variables in Render:
   - `MONGODB_URI`: Atlas driver connection string with database user credentials.
   - `API_AUTH_USERNAME`: a new web login username.
   - `API_AUTH_PASSWORD`: a long, unique web login password; this is separate from the Atlas database password.
4. Deploy and open the Render service URL. The browser asks for the web login. Use `/api/health` for the deployment health check.

Render's free service may spin down while idle and take time to wake. Its filesystem is ephemeral, so `database-backup.json` on Render is not a durable backup; Atlas remains the persistent database. Keep the local folder backup and store a copy somewhere safe. For Atlas Network Access, use the service's outbound IP addresses shown in Render rather than allowing every IP if possible. This deployment is for controlled testing only.

## Endpoints

### Health check

`GET /api/health`

Returns API and MongoDB availability.

### Download the report workbook template

`GET /report-template.xlsx`

Returns the cleaned Excel template used by the app's **Tải Excel toàn bộ** export. The template keeps its report sheets, formatting, and formulas without the original vessel records.

### Monthly formula engine

`GET /monthly-formulas.js`

Serves the client-side calculation functions used to update the monthly summary and report worksheets.

### Calculate a monthly dataset

`GET /api/calculate/{key}`

Calculates the monthly worksheet for a saved dataset. The response includes the dataset key, calculation time, vessel count, row count, formula error count, and calculated worksheet result. Returns `400` for an invalid key, `404` when the dataset does not exist, and `500` if calculation fails.

### List monthly datasets

`GET /api/datasets`

Returns each stored key, update timestamp, and vessel count.

### Read a dataset

`GET /api/datasets/{key}`

Returns the complete monthly dataset.

### Save or replace a dataset

`PUT /api/datasets/{key}`

Send JSON with a `vessels` array. Each vessel record must include a string `shipName`. Example:

```json
{
  "vessels": [
    {
      "id": 1,
      "shipName": "EXAMPLE VESSEL",
      "vesselClass": "sea"
    }
  ],
  "reportPeriodLabel": "02/2026"
}
```

### Delete a dataset

`DELETE /api/datasets/{key}`

Dataset keys are URL path components; URL-encode keys containing spaces or special characters.

### Read all app data

`GET /api/state`

Returns the complete app state or `{"state":null}` if no state has been stored yet.

### Read app data metadata

`GET /api/state/meta`

Returns whether app data exists, its active month key, and its last update time without downloading the complete state. The browser uses this endpoint to avoid reloading unchanged multi-month data.

### Save all app data

`PUT /api/state`

Stores the version 3 app state (active month and all monthly datasets) in the `applicationState` collection using majority write concern, synchronizes each month as its own document in `datasets`, and refreshes `database-backup.json`. The app sends this automatically after local changes and asks which copy to use if browser and Atlas data differ at startup. The UI reports **Atlas + backup đã lưu** only after MongoDB acknowledges the write, the API confirms every monthly dataset, and the local backup file is replaced.

State writes require JSON and are limited to 12 MiB per request and 15 MiB per MongoDB document. The existing per-dataset endpoints remain available for development tools.

### Aggregate report by period and area

`GET /api/tong-hop?kyBaoCao={period}&nam={year}&khuVuc={area}&thang={month}`

Supported `kyBaoCao` values are `thang`, `6thang-dau`, `6thang-cuoi`, `nam`, and `6thang-gan-nhat`. `nam` defaults to the current year; `khuVuc` defaults to `Tổng hợp` and accepts that value or one of the six fixed areas. `thang` is required for `kyBaoCao=thang`. Invalid periods, years, months, or areas return `400`.

The API aggregates saved monthly `datasets` in MongoDB using `$unwind` and `$group`; it does not return vessel records. It returns the selected area rows (all six when `khuVuc=Tổng hợp`) plus `total`, which is calculated from the six grouped area results. Cargo and passenger quantities follow each dataset's reporting month; vessel calls are counted from `dateIn` and `dateOut` within the selected period. The response includes data months and months without saved records. A current-year period stops at the current month.

Metrics include cargo tonnes by type, container tonnes/TEU, vessel calls by port class and route, and passenger counts. Percentages, plans, average values, and vessel attributes such as GRT/DWT are not summed. The existing `_id` month-key lookup and `data.vessels.khuVuc` index support the query.

### List vessels by area

`GET /api/vessels?khuVuc={area}&monthKey={key}`

`khuVuc` is required and must be one of the six fixed area names or `Tổng hợp`. `monthKey` is optional; when omitted, all saved monthly datasets are searched. “Tổng hợp” returns all records, with each record's `khuVuc` and `monthKey`. Invalid areas or month keys return `400`.

### Add a vessel

`POST /api/vessels`

Send JSON containing `monthKey` and `vessel`. The vessel must include a valid `khuVuc`, non-empty `shipName`, and string `callSign`, `dateIn`, and `port` fields sufficient to form the duplicate key. The key is area + normalized call sign (vessel name is used when call sign is blank or `N/A`) + arrival date + normalized port. A matching record in the same month is updated rather than duplicated. Returns the saved vessel and `action` (`inserted` or `updated`).

### Edit or delete a vessel

`PUT /api/vessels/{monthKey}/{id}` accepts `{ "vessel": { ... } }` JSON and validates the area's value. `DELETE /api/vessels/{monthKey}/{id}?khuVuc={area}` deletes only if the given area matches the saved record. Both persist the updated application state, monthly snapshots, and backup.

### Import vessels from Excel

`POST /api/vessels/import?khuVuc=auto&monthKey={key}`

Send a raw XLSX request body (`Content-Type: application/octet-stream`; maximum 12 MiB). The workbook needs a sheet with `Tên tàu`, `GRT`, and `DWT` headers. Recognized optional columns include nationality/type, call sign/IMO, length/draft/clearance, incoming/outgoing cargo names/types/handling/amounts/units, passenger counts, previous/current/next ports, arrival/departure dates, and agent. The app converts legacy `.xls` and CSV uploads to XLSX before calling this endpoint. With `khuVuc=auto`, each row's area is inferred from its `Cảng làm hàng`/`Bến làm hàng` value using the shared port list and aliases in `regional-areas.js`; this works for mixed-area workbooks and does not depend on the selected sidebar tab. Rows with a missing or unrecognized port are skipped and returned in `errors` with their row number and reason, rather than assigned to the currently selected area. A concrete `khuVuc` can still be supplied to force one area for every row. Successful rows are inserted or updated using the duplicate key above; existing rows absent from the file are preserved. The response includes `inserted`, `updated`, `skipped`, `errors`, and saved vessels with their inferred `khuVuc`.
