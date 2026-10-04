# MongoDB API

This directory contains a development API for storing vessel statistics in MongoDB. The app page automatically synchronizes the complete monthly state while the API is running, keeps a browser-local copy as a fallback, and writes an atomic JSON database backup to `database-backup.json` after each confirmed MongoDB save.

## Requirements

- Node.js 20 or later
- A MongoDB server, either local or hosted

## Run locally on Windows

1. Install Node.js 20 or later.
2. In MongoDB Atlas, open the cluster and:
   - Add a database user under **Security → Database Access**. Use a dedicated username and password; do not use an Atlas account password.
   - Add your current IP address under **Security → Network Access**. Avoid allowing access from `0.0.0.0/0`.
   - Choose **Connect → Drivers → Node.js** and copy the connection string.
3. Copy `.env.example` to `.env`. Set `MONGODB_URI` to the copied connection string, replace its password placeholder with the database user's password, and set the database name to `maritime_statistics`. URL-encode special characters in the password. Keep `.env` private; it is excluded by `.gitignore`.
4. Keep `API_PORT=3000`. The API also serves `main.html` from the same origin, so the browser does not need cross-origin access.
5. In PowerShell, from this directory, run:

   ```powershell
   npm install
   npm start
   ```

   The server loads values from `.env`; environment variables already set in PowerShell take precedence.

6. Open `http://127.0.0.1:3000/api/health` to check that the API can reach Atlas, then use the app at `http://127.0.0.1:3000/`. Do not open `main.html` directly as a file if you want MongoDB synchronization.

The API binds to `127.0.0.1` by default. Binding to a public interface requires `API_AUTH_USERNAME` and `API_AUTH_PASSWORD`; the app and API then use HTTP Basic authentication, which Render delivers over HTTPS. Never put the MongoDB URI, database password, or web login password in `main.html` or Git. The test deployment is for controlled testing only, not production identity/access management.

The latest full application-state and monthly dataset snapshot is stored locally in `database-backup.json` in this directory. The file is refreshed only after MongoDB confirms the save and is excluded from Git. Copy it to separate secure storage periodically for protection against disk loss; a backup in the same folder is not protection against failure of that disk.

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

### Save all app data

`PUT /api/state`

Stores the version 3 app state (active month and all monthly datasets) in the `applicationState` collection using majority write concern, synchronizes each month as its own document in `datasets`, and refreshes `database-backup.json`. The app sends this automatically after local changes and asks which copy to use if browser and Atlas data differ at startup. The UI reports **Atlas + backup đã lưu** only after MongoDB acknowledges the write, the API confirms every monthly dataset, and the local backup file is replaced.

State writes require JSON and are limited to 12 MiB per request and 15 MiB per MongoDB document. The existing per-dataset endpoints remain available for development tools.
