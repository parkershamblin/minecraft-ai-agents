// Compose container names for host-side `docker exec` calls. The project
// half is overridable (COMPOSE_PROJECT_NAME) so an isolated stack — a
// fresh-install sim, a parallel world — doesn't strand these scripts on the
// live stack's names (audit finding F8, issue #77).
const project = process.env.COMPOSE_PROJECT_NAME ?? 'ai-civilization-engine'

export const containerName = (service, index = 1) => `${project}-${service}-${index}`
