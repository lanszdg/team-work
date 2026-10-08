/**
 * e2e-worker.js — Worker subprocess for multi-process E2E tests
 *
 * Receives config via command line args: teamName workerId workerName
 * Imports compiled dist modules; communicates results via IPC (process.send).
 *
 * Server: http://127.0.0.1:3000
 */

const [teamName, workerId, workerName] = process.argv.slice(2)
const SERVER = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const KEY = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'

async function run() {
  // Dynamic imports — resolved relative to this script at test/helpers/e2e-worker.js
  const { CloudInvitation } = await import('../../dist/core/cloudInvitation.js')
  const { readTeamFile } = await import('../../dist/core/teamFile.js')

  // 1. Discover teams on cloud
  console.log(`[Worker:${workerName}] Discovering cloud teams...`)
  const teams = await CloudInvitation.discoverCloudTeams(SERVER, KEY)
  const found = teams.find(t => t.name === teamName)
  console.log(`[Worker:${workerName}] Found ${teams.length} teams, target "${teamName}" ${found ? 'discovered' : 'NOT FOUND'}`)

  // 2. Get invitations (C14 per-team isolation repo)
  console.log(`[Worker:${workerName}] Fetching invitations...`)
  const workerInv = new CloudInvitation({
    apiUrl: SERVER, apiKey: KEY, teamName, agentId: workerId, agentName: workerName,
  })
  const invites = await workerInv.getInvitations()
  const pending = invites.filter(i => i.status === 'pending')
  console.log(`[Worker:${workerName}] ${invites.length} invites, ${pending.length} pending`)

  // 3. Accept first pending invitation
  if (pending.length > 0) {
    console.log(`[Worker:${workerName}] Accepting invitation ${pending[0].id}`)
    await workerInv.acceptInvitation(pending[0].id)
    console.log(`[Worker:${workerName}] Invitation accepted (C9 full sync)`)
  }

  // 4. Read local team file (persisted by acceptInvitation → _syncTeamDataAfterAccept)
  console.log(`[Worker:${workerName}] Reading local team file...`)
  const teamFile = readTeamFile(teamName)
  const memberCount = teamFile?.members?.length || 0
  const memberNames = teamFile?.members?.map(m => m.name) || []
  console.log(`[Worker:${workerName}] Local team: ${memberCount} members: [${memberNames.join(', ')}]`)

  // 5. Report results back to parent via IPC
  process.send({
    type: 'result',
    teamFound: !!found,
    invitationCount: pending.length,
    accepted: pending.length > 0,
    memberCount,
    members: memberNames,
  })
}

run().catch(err => {
  console.error(`[Worker:${workerName}] Fatal:`, err.message)
  process.send({ type: 'error', message: err.message, stack: err.stack })
  process.exit(1)
})
