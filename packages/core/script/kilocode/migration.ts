function board(name: string | undefined) {
  return name != null && /(?:^|_)kilocode_board(?:_reset)?$/.test(name)
}

function profiles(name: string | undefined) {
  return name?.includes("_kilocode_provider_account_") ?? false
}

function sessionLock(name: string | undefined) {
  return name?.includes("_kilocode_session_turn_lock") ?? false
}

function kilo(name: string | undefined) {
  return board(name) || profiles(name) || sessionLock(name)
}

export function file(name: string, value: string) {
  return kilo(name) ? `// kilocode_change - new file\n${value}` : value
}

export function block(name: string | undefined, source: string, value: string) {
  return (name !== undefined && kilo(name)) ||
    /kilo_board(?:_message)?|kilo_provider_account(?:_credential|_default|_import|_refresh_lock)?|kilo_session_turn_lock|part_session_step_finish_idx|recall_(?:part_search|message_role)_idx/.test(
      source,
    )
    ? `// kilocode_change start\n${value}\n// kilocode_change end`
    : value
}

export function line(name: string, value: string) {
  return kilo(name) || name.endsWith("_kilocode_model_usage_index") ? `${value} // kilocode_change` : value
}
