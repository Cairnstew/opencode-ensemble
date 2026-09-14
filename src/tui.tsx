/** @jsxImportSource @opentui/solid */
import "@opentui/solid"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"
import { EnsembleRpc } from "./rpc"

/** Notice payload shape from the server bridge. */
interface NoticeData {
  title?: string
  message: string
  variant?: "info" | "success" | "warning" | "error"
}

/** Team context shape from the server bridge. */
interface TeamContextData {
  team: string | null
  members: Array<{ name: string; status: string }>
  tasks: { pending: number; done: number }
}

/** Sidebar widget: team members with status plus task counts. */
function TeamSidebar(props: { fetchContext: () => Promise<TeamContextData | null>; onEvent: (cb: () => void) => () => void }) {
  const [state, setState] = createSignal<TeamContextData | null>(null)
  const load = async (): Promise<void> => {
    try {
      setState(await props.fetchContext())
    } catch {
      // Server unreachable — keep the last known state.
    }
  }
  onMount(() => {
    void load()
    const off = props.onEvent(() => void load())
    onCleanup(off)
  })
  return (
    <Show when={state()?.team} fallback={<text>Ensemble: no active team</text>}>
      <box flexDirection="column">
        <text>Ensemble: {state()?.team}</text>
        {(state()?.members ?? []).map((member) => (
          <text>
            {member.status === "busy" ? "●" : member.status === "ready" ? "○" : "■"} {member.name} ({member.status})
          </text>
        ))}
        <text>
          tasks: {(state()?.tasks.pending ?? 0)} open / {(state()?.tasks.done ?? 0)} done
        </text>
      </box>
    </Show>
  )
}

/**
 * Terminal companion for opencode-ensemble (issue #36).
 *
 * Toasts + attention pings on server events, plus a sidebar widget and a
 * session panel showing live team state. Enhancement only: desktop, web,
 * and companion-less terminals lose nothing functional — tools, approvals,
 * model-context messages, and the dashboard all live server-side.
 */
export default Plugin.define({
  id: "ensemble.tui",
  setup(context) {
    const rpc = context.client.rpc(EnsembleRpc)

    const offNotice = rpc.events.on("notice", (event) => {
      const data = event.data as unknown as NoticeData
      void context.ui.toast.show({
        title: data.title ?? "Team",
        message: data.message,
        variant: data.variant ?? "info",
        duration: 5000,
      })
      void context.attention.notify({
        title: data.title ?? "Ensemble",
        message: data.message,
        notification: { when: "blurred" },
        sound: { name: data.variant === "error" ? "error" : "done", volume: 0.4, when: "always" },
      })
    })

    const offMember = rpc.events.on("member", (event) => {
      const data = event.data as unknown as { memberName: string; from: string; to: string }
      if (data.to === "error") {
        void context.ui.toast.show({
          title: "Team",
          message: `${data.memberName} errored`,
          variant: "error",
          duration: 8000,
        })
      }
    })

    const onEvent = (cb: () => void): (() => void) => rpc.events.on("member", cb)

    const offSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (panel: { sessionID?: string }) => (
        <TeamSidebar
          fetchContext={async () => {
            if (!panel.sessionID) return null
            return (await rpc.teamContext({ sessionID: panel.sessionID })) as TeamContextData
          }}
          onEvent={onEvent}
        />
      ),
    })

    return () => {
      offNotice()
      offMember()
      offSidebar()
    }
  },
})
