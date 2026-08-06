# CRM web deployment in Portainer

This branch packages the Electron dashboard as a browser application at
`http://192.168.203.118:8081`. The stack uses the prebuilt local image
`crm-web:latest`; the Compose file intentionally contains no `build:` directive.

## Environment variables

| Name | Used by | Purpose |
| --- | --- | --- |
| `PORT` | `server/index.js` | CRM API listen port (`3899`) |
| `DATABASE_URL` | `server/index.js`, `server/migrate.js` | PostgreSQL connection string |
| `CRM_WEB_PORT` | `status-monitor-web/server.js` | Web container listen port (`8080`) |
| `CRM_API_URL` | `status-monitor-web/server.js` | Internal API upstream (`http://crm-api:3899`) |
| `CRM_WEB_DATA_DIR` | `status-monitor-web/server.js` | Persistent web account data path |
| `CRM_ADMIN_USERNAME` | `status-monitor-web/server.js` | First-run administrator username |
| `CRM_ADMIN_PASSWORD` | `status-monitor-web/server.js` | First-run administrator password |
| `CRM_SESSION_TTL_MS` | `status-monitor-web/server.js` | Optional login-session lifetime |
| `CRM_COOKIE_SECURE` | `status-monitor-web/server.js` | Set to `1` only when serving HTTPS |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | official PostgreSQL image | Database initialization |

The Compose substitution variable `CRM_DATABASE_PASSWORD` is used to create both
`POSTGRES_PASSWORD` and the API's `DATABASE_URL`. Set it in Portainer before
deploying.

## Build the image

Portainer Business Edition can build from a Git repository in the Images view.
For Community Edition, upload a tar archive of this branch to the image build
screen or use Portainer's Docker API build endpoint. Use:

- Repository: `https://github.com/redstonejh/CRM.git`
- Reference: `refs/heads/portainer-web`
- Dockerfile: `Dockerfile`
- Image name: `crm-web:latest`

## Deploy the stack

Create a Web editor stack named `crm-web`, paste `portainer-stack.yml`, and set:

- `CRM_DATABASE_PASSWORD` to a new strong database password
- `CRM_ADMIN_USERNAME` to `admin` (or another first-run administrator name)
- `CRM_ADMIN_PASSWORD` to a new strong administrator password

Deploy the stack, wait until `crm-postgres`, `crm-api`, and `crm-web` are healthy,
then open `http://192.168.203.118:8081`.

`CRM_ADMIN_USERNAME` and `CRM_ADMIN_PASSWORD` seed the account database only when
the `crm-web-data` volume is empty. Changing them later does not overwrite
existing users.

