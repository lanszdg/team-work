#!/usr/bin/env node
/**
 * Team CLI — T4.8
 *
 * User-perspective: "team assign <worker> <task>" instead of
 * "node -e 'import { CloudMessageRouter } from ...'"
 *
 * Usage:
 *   node scripts/team-cli.mjs assign <worker-name> <task-text>
 *   node scripts/team-cli.mjs invite <worker-id> <worker-name> [message]
 *   node scripts/team-cli.mjs status
 */

import { randomUUID } from 'crypto'

const syncUrl = process.env.TEAM_MEMORY_SYNC_URL || 'http://127.0.0.1:3000'
const apiKey = process.env.TEAM_MEMORY_SYNC_API_KEY || 'local-development-only'
const teamName = process.env.CLAUDE_CODE_TEAM_NAME
const agentId = process.env.CLAUDE_CODE_AGENT_ID || 'leader'
const agentName = process.env.CLAUDE_CODE_AGENT_NAME || 'team-lead'

if (!teamName) {
  console.error('❌ CLAUDE_CODE_TEAM_NAME not set. Are you in a team session?')
  process.exit(1)
}

const cmd = process.argv[2]

async function main() {
  switch (cmd) {
    case 'assign': {
      const to = process.argv[3]
      const text = process.argv.slice(4).join(' ')
      if (!to || !text) {
        console.error('Usage: team assign <worker-name> <task-text>')
        process.exit(1)
      }

      const { CloudMessageRouter } = await import('../dist/core/cloudMessageRouter.js')
      const router = new CloudMessageRouter({ apiUrl: syncUrl, apiKey, repo: teamName, developerId: agentId })
      const ok = await router.sendMessage({
        messageId: randomUUID(),
        type: 'task_assignment',
        from: agentName,
        to,
        text,
        timestamp: new Date().toISOString(),
        teamName,
      })
      console.log(ok ? `✅ Task assigned to ${to}` : `❌ Failed (maybe duplicate)`)
      break
    }

    case 'invite': {
      const toAgentId = process.argv[3]
      const toAgentName = process.argv[4] || toAgentId
      const message = process.argv.slice(5).join(' ') || 'Join my team!'
      if (!toAgentId) {
        console.error('Usage: team invite <worker-agent-id> [worker-name] [message]')
        process.exit(1)
      }

      const { CloudInvitation } = await import('../dist/core/cloudInvitation.js')
      const inv = new CloudInvitation({ apiUrl: syncUrl, apiKey, teamName, agentId, agentName })
      const result = await inv.sendInvitation(toAgentId, toAgentName, message)
      console.log(`✅ Invitation sent to ${toAgentName} (${result.id.slice(0, 8)}...)`)
      break
    }

    case 'create': {
      const newTeamName = process.argv[3]
      const description = process.argv.slice(4).join(' ') || ''
      if (!newTeamName) {
        console.error('Usage: team create <team-name> [description]')
        process.exit(1)
      }
      const { createTeam } = await import('../dist/core/teamFile.js')
      try {
        const tf = await createTeam({
          teamName: newTeamName,
          leadAgentId: agentId,
          description: description || undefined,
        })
        console.log(`✅ Team "${tf.name}" created (${tf.members.length} members)`)
        if (process.env.TEAM_MEMORY_SYNC_URL) {
          const { CloudInvitation } = await import('../dist/core/cloudInvitation.js')
          const teams = await CloudInvitation.discoverCloudTeams(syncUrl, apiKey)
          const found = teams.some(t => t.name === tf.name)
          if (!found) {
            throw new Error(`Cloud discovery verification failed for "${tf.name}"`)
          }
          console.log(`   Cloud synced and discoverable. Workers can now discover and join.`)
        } else {
          console.log(`   Local only (no TEAM_MEMORY_SYNC_URL configured).`)
        }
      } catch (err) {
        console.error(`❌ Team creation failed: ${err.message}`)
        process.exit(1)
      }
      break
    }

    case 'status': {
      const { readTeamFile, pullTeamFromCloud } = await import('../dist/core/teamFile.js')
      const local = readTeamFile(teamName)
      console.log(`Team: ${teamName}`)
      if (local) {
        for (const m of local.members) {
          const icon = m.isActive ? '🟢' : '🟡'
          console.log(`  ${icon} ${m.name} (${m.agentId}) mode=${m.mode || '?'}`)
        }
      }
      try {
        const cloud = await pullTeamFromCloud(teamName)
        if (cloud) {
          console.log(`  Cloud: ${cloud.members.length} members synced`)
        }
      } catch { /* cloud unreachable */ }
      break
    }

    default:
      console.log(`Team CLI — ${teamName}
  create <name> [desc]       Create a new team (cloud synced)
  assign <worker> <task>     Assign a task via cloud KV+SSE
  invite <id> [name] [msg]   Send cloud invitation
  status                     Show team status
`)
  }
}

main().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})
