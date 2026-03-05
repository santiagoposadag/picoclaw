import { useAtom } from "jotai"
import { useCallback, useEffect, useState } from "react"

import { getGatewayStatus, startGateway, stopGateway } from "@/api/gateway"
import { gatewayAtom } from "@/store"

// Global variable to ensure we only have one SSE connection
let sseInitialized = false

export function useGateway() {
  const [{ status: state, isInitialized }, setGateway] = useAtom(gatewayAtom)
  const [loading, setLoading] = useState(false)

  // Initialize global SSE connection once
  useEffect(() => {
    if (sseInitialized) return
    sseInitialized = true

    getGatewayStatus()
      .then((data) => {
        setGateway({
          status: data.gateway_status ?? "unknown",
          isInitialized: true,
        })
      })
      .catch(() => {
        setGateway({
          status: "unknown",
          isInitialized: true,
        })
      })

    // Subscribe to SSE for real-time updates globally
    const es = new EventSource("/api/gateway/events")

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.gateway_status) {
          setGateway((prev) => ({ ...prev, status: data.gateway_status }))
        }
      } catch {
        // ignore
      }
    }

    es.onerror = () => {
      // EventSource will auto-reconnect
      setGateway((prev) => ({ ...prev, status: "unknown" }))
    }

    return () => {
      es.close()
      sseInitialized = false
    }
  }, [setGateway])

  const start = useCallback(async () => {
    setLoading(true)
    try {
      await startGateway()
      // SSE will push the real state changes, but set optimistic state
      setGateway((prev) => ({ ...prev, status: "starting" }))
    } catch (err) {
      console.error("Failed to start gateway:", err)
      setGateway((prev) => ({ ...prev, status: "unknown" }))
    } finally {
      setLoading(false)
    }
  }, [setGateway])

  const stop = useCallback(async () => {
    setLoading(true)
    try {
      await stopGateway()
    } catch (err) {
      console.error("Failed to stop gateway:", err)
    } finally {
      setLoading(false)
    }
  }, [])

  return { state, loading, isInitialized, start, stop }
}
