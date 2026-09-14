import { Plugin } from "@opencode/plugin/tui"
import { EnsembleRpc } from "./rpc"

/** Notice payload shape from the server bridge. */
interface NoticeData {
  title?: string
  message: string
  variant?: "info" | "success" | "warning" | "error"
}

/**
 * Terminal companion for opencode-ensemble (issue #36).
 *
 * Subscribes to the server plugin's RPC events and renders them as toasts
 * plus attention pings. Enhancement only: desktop, web, and companion-less
 * terminals lose nothing functional — tools, approvals, model-context
 * messages, and the dashboard all live server-side.
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

    return () => {
      offNotice()
      offMember()
    }
  },
})
