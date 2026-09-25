export function primaryToolMcpArguments(server: { command: string; args: string[] }): string[] {
  return [
    "-c", `mcp_servers.herdr_agent_swarm.command=${JSON.stringify(server.command)}`,
    "-c", `mcp_servers.herdr_agent_swarm.args=${JSON.stringify(server.args)}`,
    "-c", 'mcp_servers.herdr_agent_swarm.env_vars=["SWARM_PRIMARY_CAPABILITY"]'
  ];
}
