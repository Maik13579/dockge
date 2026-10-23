# Container layout and actions

The container toolbar in stacks and stack groups has Columns (1–4), Sort, sort direction, and Cards/Compact controls. One column and status sorting are the defaults. Narrow lists automatically use fewer columns; edit mode stays in source order and one column. Browser preferences are shared across stacks and groups.

Failures stay first for every sorting strategy. CPU and memory sort numerically and sum measurements across a service's replicas. Missing measurements sort after measured values within the error/healthy groups. Image sorting on Home offers name, size, creation date, and container usage count, alongside the existing search and untagged filter.

Running cards have Stop / Kill / Restart / Down and Pull / Build / Exec / Logs. Stopped cards have Up / Pull / Logs and Rm / Build. Expand a compact row for these actions.

Build uses the saved, effective Compose configuration, including includes and overrides, and only builds images; use Up to apply them. It is disabled without a build configuration. The arrow beside Pull also offers stack/group Build. Group members without build configurations are skipped. New commands require updated agents.

Card Down stops and removes the selected service's replicas (`compose rm --stop --force SERVICE`). Rm removes stopped replicas (`compose rm --force SERVICE`). Neither removes volumes, images, other services, or shared networks. Stack-level Down continues to use Compose down.

# Kill all

The Home button opens a dialog with managed/all scope, optional container removal, and online agent selection. Defaults are managed scope, kill only, and no selected devices. The dialog previews affected and protected counts independently for each device. Previews expire after five minutes; changing options or selected agents loads new previews.

Kill-only sends Docker kill to active containers. Kill-and-remove uses Docker rm --force for previewed matching containers, including existing stopped/created ones. Images, volumes, networks, Compose files and stack directories are retained. Managed matching uses the device's saved stack directories/configuration paths, supporting custom Compose project names.

Every Dockge instance is excluded on the server using explicit protection labels, legacy runtime/image metadata, and local container identity. The image and example Compose file set `io.dockge.protected=true`. Retagged images retain the marker. If a containerized Dockge cannot corroborate its own identity, bulk actions are refused. Protection and scope are rechecked immediately before each destructive command; containers created after preview are not added automatically.

Each device permits one bulk operation at a time. Conflicting Compose operations are blocked, and pending targeted Up/update commands are cancelled before mutations. Results show per-container success, skips, and failures. Devices proceed independently, and destructive requests are never automatically retried. Job IDs are retained in browser storage so Home can recover status after refreshing; the agent retains jobs in memory for at least 30 minutes after preview expiry. Restarting an agent loses its in-memory job history.

Rebuild/deploy the updated Dockge image on the viewing instance and participating agents to enable all actions. No additional services or dependencies are needed.
