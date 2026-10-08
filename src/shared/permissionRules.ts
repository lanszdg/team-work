/**
 * Shared Permission Rule Utilities
 *
 * Common file-path matching and extraction utilities used by
 * both the Claude Code and Open Code platform adapters.
 */

/**
 * Extracts a file path from tool input based on tool name.
 * Handles both PascalCase (Claude Code) and lowercase (Open Code) tool naming.
 */
export function extractFilePath(
  toolName: string,
  input: Record<string, unknown>,
): string | null {
  const normalized = toolName.toLowerCase()
  switch (normalized) {
    case 'edit':
    case 'write':
    case 'read':
      return typeof input.file_path === 'string' ? input.file_path : null
    case 'bash':
      // Extract file paths from bash command (simplified)
      return null
    default:
      return null
  }
}

/**
 * Checks if a file path matches an allowed path rule.
 *
 * - Absolute rule (starts with '/'): filePath must start with the rule path
 * - Relative rule: filePath must end with the rule path or contain it
 */
export function pathMatchesRule(filePath: string, rulePath: string): boolean {
  if (rulePath.startsWith('/')) {
    // Absolute path rule: check if filePath starts with the rule path
    return filePath.startsWith(rulePath) || filePath.startsWith(rulePath.slice(1))
  }
  // Relative path rule: check if filePath ends with the rule path
  return filePath.endsWith(rulePath) || filePath.includes(`/${rulePath}/`)
}
