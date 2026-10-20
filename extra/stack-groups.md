# Stack groups

Use **Stack / Stack Group** below the sidebar search to switch between ordinary stacks and groups. In group mode, **Add stack group** lets you choose an owning agent and select member stacks from that agent's directory.

Groups are stored in `groups.yaml` at the root of the owner's configured stacks directory (normally `/opt/stacks/groups.yaml`):

```yaml
Robot:
  - Current:RobotCore
  - Jetson:perception
Monitoring:
  - Current:monitoring
```

`Current` always means the group owner, even when viewing or starting the group through another Dockge instance. Other names refer to the friendly names configured on the owner. The owner's agent connections and credentials are used; the viewing instance does not need direct connections to every member.

An explicit endpoint is also supported, for example `192.168.1.20:5001:perception`. Duplicate friendly names are rejected; use the endpoint to distinguish them. Update the references if an owning agent's friendly names change. A physical stack cannot appear twice in the same group.

Failed exits, restarting, dead and unhealthy containers sort first and have a red border, tinted background and a reason badge in both Cards and Compact views. Stack badges show Error when any container needs attention, including a failed replica alongside a running replica. Successful jobs (exit code 0) are not flagged. Stack groups show an error summary across their members.

The group view combines the member containers and their CPU/memory statistics, with Cards/Compact views and individual Up, Stop, Kill, Restart, Pull, Exec and Logs controls. The terminal selector switches between member stack logs and command output. Group controls execute across members concurrently and report a result for each stack. Stop runs Compose stop; Down runs Compose down. Unavailable members do not prevent commands on available members.

Edit changes group membership rather than Compose files. Deleting a group leaves its stacks and containers intact. External edits to `groups.yaml` appear in the sidebar on the usual refresh; use Refresh in the group view to reload resolved Compose configurations.

The group view and membership picker keep known stacks visible while refreshing agents in the background, adding results as each agent responds. Unavailable agents retain their last known containers or selectable stacks and show a warning. Agents without matching groups are hidden in the group sidebar.

Deploy the updated Dockge image on the viewing instance, the group owner, and member agents. Stack groups use the existing Dockge port and authentication; no extra service or port is needed.
