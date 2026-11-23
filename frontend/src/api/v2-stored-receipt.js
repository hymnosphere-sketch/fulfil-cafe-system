import { CommandValidationError, sameWireUuid, validateWireCommand } from './commands.js'
import { ApiProtocolError, validateAcknowledgment } from './responses.js'

// The queue retains transport metadata along with the original acknowledgment.
// Recheck both before counting it or using its commit position for another send.
export function isVerifiedStoredReceipt(entry, { generation, settingsVersion }) {
  if (entry?.resolution_status !== 'none' || !entry.acknowledgment) return false
  const { server_generation_id, settings_version, replay_status, commit_seq, ...body } = entry.acknowledgment
  if (replay_status !== 'verified' || !Number.isSafeInteger(commit_seq) || commit_seq < 1 ||
      !Number.isSafeInteger(settingsVersion) || settingsVersion < 1 || settings_version !== settingsVersion ||
      !sameWireUuid(server_generation_id, generation)) return false

  try {
    validateAcknowledgment(body, validateWireCommand(entry.command))
    return true
  } catch (error) {
    if (error instanceof ApiProtocolError || error instanceof CommandValidationError) return false
    throw error
  }
}
