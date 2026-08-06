# CRM

Electron desktop client and browser-deployable CRM backed by a PostgreSQL API.
The desktop client can optionally use CDMS as its authenticated source for
external people, company, and infrastructure records.

## Local development

Install dependencies and migrate the database:

```powershell
npm install
npm run db:migrate
```

Start the API and Electron client in separate terminals:

```powershell
npm run server
npm start
```

`DATABASE_URL` defaults to
`postgres://postgres:postgres@127.0.0.1:5432/crm`. Set it before migration and
server startup when using another PostgreSQL instance.

## CDMS connection

The Electron client connects to `http://192.168.203.238:6030` by default. Set
`CRM_CDMS_URL` to override it, set `CRM_CDMS_DISABLED=1` to disable the
integration, or change the URL in **Account → Backend**.

CDMS credentials and secret fields are filtered in the Electron main process
before records reach the renderer. If CDMS is unavailable, the local account
system remains available as an offline fallback.

Run the integration checks with:

```powershell
npm run test:cdms
npm run test:cdms:electron
npm run test:cdms:auth
```

## Build and verification

```powershell
npm test
npm run package
npm run make
```

For the containerized browser deployment, see
[PORTAINER.md](./PORTAINER.md).
