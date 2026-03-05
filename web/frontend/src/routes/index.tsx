import {
  IconArrowUp,
  IconCheck,
  IconCopy,
  IconHistory,
  IconMicrophone,
  IconPaperclip,
  IconPlugConnectedX,
  IconPlus,
  IconSparkles,
  IconTrash,
} from "@tabler/icons-react"
import { createFileRoute } from "@tanstack/react-router"
import dayjs from "dayjs"
import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import ReactMarkdown from "react-markdown"
import TextareaAutosize from "react-textarea-autosize"
import remarkGfm from "remark-gfm"

import { type ModelInfo, getModels, setDefaultModel } from "@/api/models"
import { type SessionSummary, deleteSession, getSessions } from "@/api/sessions"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useGateway } from "@/hooks/use-gateway"
import { formatMessageTime, usePicoChat } from "@/hooks/use-pico-chat"

// Assistant Message Component
function AssistantMessage({
  content,
  timestamp = "",
}: {
  content: string
  timestamp?: string | number
}) {
  const [isCopied, setIsCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    })
  }

  return (
    <div className="group flex w-full flex-col gap-1.5">
      <div className="text-muted-foreground flex items-center justify-between gap-2 px-1 text-xs opacity-70">
        <div className="flex items-center gap-2">
          <span>PicoClaw</span>
          {timestamp && (
            <>
              <span className="opacity-50">•</span>
              <span>{formatMessageTime(timestamp)}</span>
            </>
          )}
        </div>
      </div>

      <div className="bg-card text-card-foreground relative overflow-hidden rounded-xl border">
        <div className="prose dark:prose-invert prose-p:my-2 prose-pre:my-2 prose-pre:rounded-lg prose-pre:border prose-pre:bg-zinc-950 prose-pre:p-3 max-w-none p-4 text-[15px] leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="bg-background/50 hover:bg-background/80 absolute top-2 right-2 h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={handleCopy}
        >
          {isCopied ? (
            <IconCheck className="h-4 w-4 text-green-500" />
          ) : (
            <IconCopy className="text-muted-foreground h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  )
}

// User Message Component
function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex w-full flex-col items-end gap-1.5">
      <div className="max-w-[70%] rounded-2xl rounded-tr-sm bg-violet-500 px-5 py-3 text-[15px] leading-relaxed text-white shadow-sm">
        {content}
      </div>
    </div>
  )
}

function TypingIndicator() {
  const { t } = useTranslation()
  const thinkingSteps = [
    t("chat.thinking.step1"),
    t("chat.thinking.step2"),
    t("chat.thinking.step3"),
    t("chat.thinking.step4"),
  ]
  const [stepIndex, setStepIndex] = useState(0)

  useEffect(() => {
    const stepsCount = thinkingSteps.length
    const interval = setInterval(() => {
      setStepIndex((prev) => (prev + 1) % stepsCount)
    }, 3000)
    return () => clearInterval(interval)
  }, [thinkingSteps.length])

  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs opacity-70">
        <span>PicoClaw</span>
      </div>
      <div className="bg-card inline-flex w-fit max-w-xs flex-col gap-3 rounded-xl border px-5 py-4">
        {/* Bouncing dots */}
        <div className="flex items-center gap-1.5">
          <span className="size-2 animate-bounce rounded-full bg-violet-400/70 [animation-delay:-0.3s]" />
          <span className="size-2 animate-bounce rounded-full bg-violet-400/70 [animation-delay:-0.15s]" />
          <span className="size-2 animate-bounce rounded-full bg-violet-400/70" />
        </div>

        {/* Shimmer progress bar */}
        <div className="bg-muted relative h-1 w-36 overflow-hidden rounded-full">
          <div className="absolute inset-0 animate-[shimmer_2s_infinite] rounded-full bg-gradient-to-r from-violet-500/60 via-violet-400/80 to-violet-500/60 bg-[length:200%_100%]" />
        </div>

        {/* Rotating status text */}
        <p
          key={stepIndex}
          className="text-muted-foreground animate-[fadeSlideIn_0.4s_ease-out] text-xs"
        >
          {thinkingSteps[stepIndex]}
        </p>
      </div>
    </div>
  )
}

export const Route = createFileRoute("/")({
  component: Index,
})

const LIMIT = 20

function Index() {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<HTMLDivElement>(null)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [input, setInput] = useState("")
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [modelList, setModelList] = useState<ModelInfo[]>([])
  const [defaultModelName, setDefaultModelName] = useState("")

  const {
    messages,
    isTyping,
    activeSessionId,
    sendMessage,
    switchSession,
    newChat,
  } = usePicoChat()

  const { state: gwState } = useGateway()
  const isConnected = gwState === "running"
  const hasConfiguredModels = modelList.some((m) => m.configured)

  const oauthModels = modelList.filter(
    (m) => m.configured && m.auth_method === "oauth",
  )
  const localModels = modelList.filter(
    (m) =>
      m.configured &&
      (m.auth_method === "local" ||
        (!m.auth_method &&
          (m.api_base?.includes("localhost") ||
            m.api_base?.includes("127.0.0.1")))),
  )
  const apiKeyModels = modelList.filter(
    (m) => m.configured && !oauthModels.includes(m) && !localModels.includes(m),
  )

  // Load models list
  const loadModels = useCallback(async () => {
    try {
      const data = await getModels()
      setModelList(data.models)
      if (data.models.some((m) => m.model_name === data.default_model)) {
        setDefaultModelName(data.default_model)
      }
    } catch {
      // silently fail
    }
  }, [])

  // Fetch models on mount and when gateway connects
  useEffect(() => {
    loadModels()
  }, [isConnected, loadModels])

  const handleSetDefault = async (modelName: string) => {
    try {
      await setDefaultModel(modelName)
      setDefaultModelName(modelName)
      setModelList((prev) =>
        prev.map((m) => ({ ...m, is_default: m.model_name === modelName })),
      )
    } catch (err) {
      console.error("Failed to set default model:", err)
    }
  }

  const loadSessions = useCallback(
    async (reset = true) => {
      try {
        const currentOffset = reset ? 0 : offset
        if (reset) {
          setHasMore(true)
          setOffset(0)
        }

        const data = await getSessions(currentOffset, LIMIT)

        if (data.length < LIMIT) {
          setHasMore(false)
        }

        if (reset) {
          setSessions(data)
        } else {
          setSessions((prev) => {
            // Filter out duplicates just in case
            const existingIds = new Set(prev.map((s) => s.id))
            const newItems = data.filter((s) => !existingIds.has(s.id))
            return [...prev, ...newItems]
          })
        }

        setOffset(currentOffset + data.length)
      } catch {
        // silently fail
      } finally {
        setIsLoadingMore(false)
      }
    },
    [offset],
  )

  // Intersection Observer for infinite scrolling
  useEffect(() => {
    if (!observerRef.current || !hasMore || isLoadingMore) return

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          setIsLoadingMore(true)
          loadSessions(false)
        }
      },
      { threshold: 0.1 },
    )

    observer.observe(observerRef.current)

    return () => observer.disconnect()
  }, [hasMore, isLoadingMore, loadSessions])

  const handleDeleteSession = async (id: string) => {
    try {
      await deleteSession(id)
      setSessions((prev) => prev.filter((s) => s.id !== id))
      if (id === activeSessionId) {
        newChat()
      }
    } catch (err) {
      console.error("Failed to delete session:", err)
    }
  }

  // Track if user has naturally scrolled away from the bottom
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget
    setIsAtBottom(scrollHeight - scrollTop <= clientHeight + 10)
  }

  // Auto-scroll to bottom when new messages arrive (if already at bottom)
  useEffect(() => {
    if (isAtBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, isTyping, isAtBottom])

  const handleSend = () => {
    if (!input.trim() || !isConnected) return
    sendMessage(input.trim())
    setInput("")
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="bg-background/95 flex h-full flex-col">
      <PageHeader
        title="Chat"
        titleExtra={
          <Select value={defaultModelName} onValueChange={handleSetDefault}>
            <SelectTrigger
              size="sm"
              className="text-muted-foreground hover:text-foreground focus-visible:border-input h-8 max-w-[160px] min-w-[80px] bg-transparent shadow-none focus-visible:ring-0 sm:max-w-[220px]"
            >
              <SelectValue placeholder={t("chat.noModel")} />
            </SelectTrigger>
            <SelectContent>
              {apiKeyModels.length > 0 && (
                <SelectGroup>
                  <SelectLabel>
                    {t("chat.modelGroup.apikey", "API Key")}
                  </SelectLabel>
                  {apiKeyModels.map((model) => (
                    <SelectItem key={model.index} value={model.model_name}>
                      {model.model_name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {apiKeyModels.length > 0 &&
                (oauthModels.length > 0 || localModels.length > 0) && (
                  <SelectSeparator />
                )}

              {oauthModels.length > 0 && (
                <SelectGroup>
                  <SelectLabel>
                    {t("chat.modelGroup.oauth", "OAuth")}
                  </SelectLabel>
                  {oauthModels.map((model) => (
                    <SelectItem key={model.index} value={model.model_name}>
                      {model.model_name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {oauthModels.length > 0 &&
                (localModels.length > 0 || apiKeyModels.length > 0) && (
                  <SelectSeparator />
                )}

              {localModels.length > 0 && (
                <SelectGroup>
                  <SelectLabel>
                    {t("chat.modelGroup.local", "Local")}
                  </SelectLabel>
                  {localModels.map((model) => (
                    <SelectItem key={model.index} value={model.model_name}>
                      {model.model_name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        }
      >
        <Button
          variant="outline"
          size="sm"
          onClick={newChat}
          className="h-9 gap-2"
        >
          <IconPlus className="size-4" />
          <span className="hidden sm:inline">{t("chat.newChat")}</span>
        </Button>

        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              loadSessions(true)
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 gap-2">
              <IconHistory className="size-4" />
              <span className="hidden sm:inline">{t("chat.history")}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <ScrollArea className="max-h-[300px]">
              {sessions.length === 0 ? (
                <DropdownMenuItem disabled>
                  <span className="text-muted-foreground text-xs">
                    {t("chat.noHistory")}
                  </span>
                </DropdownMenuItem>
              ) : (
                sessions.map((session) => (
                  <DropdownMenuItem
                    key={session.id}
                    className={`group relative my-0.5 flex flex-col items-start gap-0.5 pr-8 ${
                      session.id === activeSessionId ? "bg-accent" : ""
                    }`}
                    onClick={() => switchSession(session.id)}
                  >
                    <span className="line-clamp-1 text-sm font-medium">
                      {session.preview}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {t("chat.messagesCount", {
                        count: session.message_count,
                      })}{" "}
                      · {dayjs(session.updated).fromNow()}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive absolute top-1/2 right-2 h-6 w-6 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100"
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        handleDeleteSession(session.id)
                      }}
                    >
                      <IconTrash className="h-4 w-4" />
                    </Button>
                  </DropdownMenuItem>
                ))
              )}
              {hasMore && sessions.length > 0 && (
                <div ref={observerRef} className="py-2 text-center">
                  <span className="text-muted-foreground animate-pulse text-xs">
                    Loading more...
                  </span>
                </div>
              )}
            </ScrollArea>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>
      {/* Chat Messages Area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-8 lg:px-24 xl:px-48"
      >
        <div className="mx-auto flex w-full max-w-[1000px] flex-col gap-8 pb-8">
          {messages.length === 0 && !isTyping && (
            <div className="flex flex-col items-center justify-center py-20 opacity-70">
              {!hasConfiguredModels || !defaultModelName ? (
                <>
                  <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500">
                    <IconSparkles className="h-8 w-8" />
                  </div>
                  <h3 className="mb-2 text-xl font-medium">
                    {t("chat.setupModel.title")}
                  </h3>
                  <p className="text-muted-foreground mb-4 max-w-sm text-center text-sm">
                    {t("chat.setupModel.description")}
                  </p>
                </>
              ) : !isConnected ? (
                <>
                  <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500">
                    <IconPlugConnectedX className="h-8 w-8" />
                  </div>
                  <p className="text-muted-foreground mb-4 max-w-sm text-center text-sm">
                    {t("chat.connectFirst")}
                  </p>
                </>
              ) : (
                <>
                  <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-500">
                    <IconMicrophone className="h-8 w-8" />
                  </div>
                  <h3 className="mb-2 text-xl font-medium">
                    {t("chat.welcome")}
                  </h3>
                  <p className="text-muted-foreground max-w-sm text-center text-sm">
                    {t("chat.welcomeDesc")}
                  </p>
                </>
              )}
            </div>
          )}

          {messages.map((msg) => (
            <div key={msg.id} className="flex w-full">
              {msg.role === "assistant" ? (
                <AssistantMessage
                  content={msg.content}
                  timestamp={msg.timestamp}
                />
              ) : (
                <UserMessage content={msg.content} />
              )}
            </div>
          ))}

          {isTyping && <TypingIndicator />}
        </div>
      </div>

      {/* Input Area */}
      <div className="bg-background shrink-0 px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-8 md:pb-8 lg:px-24 xl:px-48">
        <div className="bg-card mx-auto flex max-w-[1000px] flex-col rounded-2xl border p-3 shadow-md">
          <TextareaAutosize
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("chat.placeholder")}
            disabled={!isConnected || !defaultModelName}
            className="max-h-[200px] min-h-[60px] resize-none border-0 bg-transparent px-2 py-1 text-[15px] shadow-none focus-visible:ring-0 focus-visible:outline-none dark:bg-transparent"
            minRows={1}
            maxRows={8}
          />

          <div className="mt-2 flex items-center justify-between px-1">
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground size-8 rounded-full"
                    disabled={!isConnected}
                  >
                    <IconPaperclip className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("chat.attach")}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground size-8 rounded-full"
                    disabled={!isConnected}
                  >
                    <IconMicrophone className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("chat.voice")}</TooltipContent>
              </Tooltip>
            </div>

            <Button
              size="icon"
              className="size-8 rounded-full bg-violet-500 text-white transition-transform hover:bg-violet-600 active:scale-95"
              onClick={handleSend}
              disabled={!input.trim() || !isConnected}
            >
              <IconArrowUp className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
