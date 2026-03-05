import {
  IconChevronDown,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconKey,
  IconLoader2,
  IconPlus,
  IconStar,
  IconStarFilled,
  IconTrash,
} from "@tabler/icons-react"
import { createFileRoute } from "@tanstack/react-router"
import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import {
  type ModelInfo,
  addModel,
  deleteModel,
  getModels,
  setDefaultModel,
  updateModel,
} from "@/api/models"
import { PageHeader } from "@/components/page-header"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

export const Route = createFileRoute("/models")({
  component: ModelsPage,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProviderLabel(model: string): string {
  const prefix = model.split("/")[0]
  const labels: Record<string, string> = {
    openai: "OpenAI",
    anthropic: "Anthropic",
    gemini: "Google Gemini",
    deepseek: "DeepSeek",
    qwen: "Qwen (阿里云)",
    moonshot: "Moonshot (月之暗面)",
    groq: "Groq",
    openrouter: "OpenRouter",
    nvidia: "NVIDIA",
    cerebras: "Cerebras",
    volcengine: "Volcengine (火山引擎)",
    shengsuanyun: "ShengsuanYun (神算云)",
    antigravity: "Google Code Assist",
    "github-copilot": "GitHub Copilot",
    ollama: "Ollama (local)",
    mistral: "Mistral AI",
    avian: "Avian",
    vllm: "VLLM (local)",
    zhipu: "Zhipu AI (智谱)",
  }
  return labels[prefix] ?? prefix
}

// ---------------------------------------------------------------------------
// Shared form field
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string
  hint?: string
  children: React.ReactNode
}

function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// API key input with show/hide toggle
// ---------------------------------------------------------------------------

interface KeyInputProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}

function KeyInput({ value, onChange, placeholder }: KeyInputProps) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-10"
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        tabIndex={-1}
        className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2 transition-colors"
      >
        {show ? (
          <IconEyeOff className="size-4" />
        ) : (
          <IconEye className="size-4" />
        )}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Advanced options toggle
// ---------------------------------------------------------------------------

interface AdvancedSectionProps {
  children: React.ReactNode
}

function AdvancedSection({ children }: AdvancedSectionProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <div className="border-border/50 rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-muted/40 flex w-full items-center justify-between rounded-lg px-4 py-3 transition-colors"
      >
        <span className="text-muted-foreground text-sm">
          {t("models.advanced.toggle")}
        </span>
        <IconChevronDown
          className={[
            "text-muted-foreground size-4 transition-transform duration-200",
            open ? "rotate-180" : "",
          ].join(" ")}
        />
      </button>
      {open && (
        <div className="border-border/30 space-y-5 border-t px-4 pt-4 pb-4">
          {children}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Edit sheet
// ---------------------------------------------------------------------------

interface EditForm {
  apiKey: string
  apiBase: string
  proxy: string
  authMethod: string
  connectMode: string
  workspace: string
  rpm: string
  maxTokensField: string
  requestTimeout: string
  thinkingLevel: string
}

interface EditSheetProps {
  model: ModelInfo | null
  open: boolean
  onClose: () => void
  onSaved: () => void
}

function EditSheet({ model, open, onClose, onSaved }: EditSheetProps) {
  const { t } = useTranslation()
  const [form, setForm] = useState<EditForm>({
    apiKey: "",
    apiBase: "",
    proxy: "",
    authMethod: "",
    connectMode: "",
    workspace: "",
    rpm: "",
    maxTokensField: "",
    requestTimeout: "",
    thinkingLevel: "",
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (model) {
      setForm({
        apiKey: "",
        apiBase: model.api_base ?? "",
        proxy: model.proxy ?? "",
        authMethod: model.auth_method ?? "",
        connectMode: model.connect_mode ?? "",
        workspace: model.workspace ?? "",
        rpm: model.rpm ? String(model.rpm) : "",
        maxTokensField: model.max_tokens_field ?? "",
        requestTimeout: model.request_timeout
          ? String(model.request_timeout)
          : "",
        thinkingLevel: model.thinking_level ?? "",
      })
      setError("")
    }
  }, [model])

  const setF =
    (key: keyof EditForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [key]: e.target.value }))

  const handleSave = async () => {
    if (!model) return
    setSaving(true)
    setError("")
    try {
      await updateModel(model.index, {
        model_name: model.model_name,
        model: model.model,
        api_base: form.apiBase || undefined,
        api_key: form.apiKey || undefined,
        proxy: form.proxy || undefined,
        auth_method: form.authMethod || undefined,
        connect_mode: form.connectMode || undefined,
        workspace: form.workspace || undefined,
        rpm: form.rpm ? Number(form.rpm) : undefined,
        max_tokens_field: form.maxTokensField || undefined,
        request_timeout: form.requestTimeout
          ? Number(form.requestTimeout)
          : undefined,
        thinking_level: form.thinkingLevel || undefined,
      })
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : t("models.edit.saveError"))
    } finally {
      setSaving(false)
    }
  }

  const isOAuth = model?.auth_method === "oauth"

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="flex flex-col gap-0 p-0">
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle className="text-base">
            {t("models.edit.title", { name: model?.model_name })}
          </SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {model?.model}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-5 px-6 py-5">
            {/* ── Basic fields ── */}
            <Field label={t("models.field.apiBase")}>
              <Input
                value={form.apiBase}
                onChange={setF("apiBase")}
                placeholder="https://api.example.com/v1"
                disabled={isOAuth}
              />
              {isOAuth && (
                <p className="text-muted-foreground text-xs">
                  {t("models.edit.oauthNote")}
                </p>
              )}
            </Field>

            {!isOAuth && (
              <Field
                label={t("models.field.apiKey")}
                hint={
                  model?.configured ? t("models.edit.apiKeyHint") : undefined
                }
              >
                <KeyInput
                  value={form.apiKey}
                  onChange={(v) => setForm((f) => ({ ...f, apiKey: v }))}
                  placeholder={
                    model?.configured
                      ? t("models.field.apiKeyPlaceholderSet")
                      : t("models.field.apiKeyPlaceholder")
                  }
                />
              </Field>
            )}

            {/* ── Advanced options ── */}
            <AdvancedSection>
              <Field
                label={t("models.field.proxy")}
                hint={t("models.field.proxyHint")}
              >
                <Input
                  value={form.proxy}
                  onChange={setF("proxy")}
                  placeholder="http://127.0.0.1:7890"
                />
              </Field>

              <Field
                label={t("models.field.authMethod")}
                hint={t("models.field.authMethodHint")}
              >
                <Input
                  value={form.authMethod}
                  onChange={setF("authMethod")}
                  placeholder="oauth"
                />
              </Field>

              <Field
                label={t("models.field.connectMode")}
                hint={t("models.field.connectModeHint")}
              >
                <Input
                  value={form.connectMode}
                  onChange={setF("connectMode")}
                  placeholder="stdio"
                />
              </Field>

              <Field
                label={t("models.field.workspace")}
                hint={t("models.field.workspaceHint")}
              >
                <Input
                  value={form.workspace}
                  onChange={setF("workspace")}
                  placeholder="/path/to/workspace"
                />
              </Field>

              <Field
                label={t("models.field.requestTimeout")}
                hint={t("models.field.requestTimeoutHint")}
              >
                <Input
                  value={form.requestTimeout}
                  onChange={setF("requestTimeout")}
                  placeholder="60"
                  type="number"
                  min={0}
                />
              </Field>

              <Field
                label={t("models.field.rpm")}
                hint={t("models.field.rpmHint")}
              >
                <Input
                  value={form.rpm}
                  onChange={setF("rpm")}
                  placeholder="60"
                  type="number"
                  min={0}
                />
              </Field>

              <Field
                label={t("models.field.thinkingLevel")}
                hint={t("models.field.thinkingLevelHint")}
              >
                <Input
                  value={form.thinkingLevel}
                  onChange={setF("thinkingLevel")}
                  placeholder="off"
                />
              </Field>

              <Field
                label={t("models.field.maxTokensField")}
                hint={t("models.field.maxTokensFieldHint")}
              >
                <Input
                  value={form.maxTokensField}
                  onChange={setF("maxTokensField")}
                  placeholder="max_completion_tokens"
                />
              </Field>
            </AdvancedSection>

            {error && (
              <p className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
                {error}
              </p>
            )}
          </div>
        </div>

        <SheetFooter className="border-t px-6 py-4">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <IconLoader2 className="size-4 animate-spin" />}
            {t("common.save")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Add model sheet
// ---------------------------------------------------------------------------

interface AddForm {
  modelName: string
  model: string
  apiBase: string
  apiKey: string
  // advanced
  proxy: string
  authMethod: string
  connectMode: string
  workspace: string
  rpm: string
  maxTokensField: string
  requestTimeout: string
  thinkingLevel: string
}

const EMPTY_ADD_FORM: AddForm = {
  modelName: "",
  model: "",
  apiBase: "",
  apiKey: "",
  proxy: "",
  authMethod: "",
  connectMode: "",
  workspace: "",
  rpm: "",
  maxTokensField: "",
  requestTimeout: "",
  thinkingLevel: "",
}

interface AddSheetProps {
  open: boolean
  onClose: () => void
  onSaved: () => void
}

function AddSheet({ open, onClose, onSaved }: AddSheetProps) {
  const { t } = useTranslation()
  const [form, setForm] = useState<AddForm>(EMPTY_ADD_FORM)
  const [saving, setSaving] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<keyof AddForm, string>>
  >({})
  const [serverError, setServerError] = useState("")

  useEffect(() => {
    if (open) {
      setForm(EMPTY_ADD_FORM)
      setFieldErrors({})
      setServerError("")
    }
  }, [open])

  const validate = (): boolean => {
    const e: Partial<Record<keyof AddForm, string>> = {}
    if (!form.modelName.trim()) e.modelName = t("models.add.errorRequired")
    if (!form.model.trim()) e.model = t("models.add.errorRequired")
    setFieldErrors(e)
    return Object.keys(e).length === 0
  }

  const setField =
    (key: keyof AddForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((f) => ({ ...f, [key]: e.target.value }))
      if (fieldErrors[key])
        setFieldErrors((prev) => ({ ...prev, [key]: undefined }))
    }

  const handleSave = async () => {
    if (!validate()) return
    setSaving(true)
    setServerError("")
    try {
      await addModel({
        model_name: form.modelName.trim(),
        model: form.model.trim(),
        api_base: form.apiBase.trim() || undefined,
        api_key: form.apiKey.trim() || undefined,
        proxy: form.proxy.trim() || undefined,
        auth_method: form.authMethod.trim() || undefined,
        connect_mode: form.connectMode.trim() || undefined,
        workspace: form.workspace.trim() || undefined,
        rpm: form.rpm ? Number(form.rpm) : undefined,
        max_tokens_field: form.maxTokensField.trim() || undefined,
        request_timeout: form.requestTimeout
          ? Number(form.requestTimeout)
          : undefined,
        thinking_level: form.thinkingLevel.trim() || undefined,
      })
      onSaved()
      onClose()
    } catch (e) {
      setServerError(e instanceof Error ? e.message : t("models.add.saveError"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent
        side="right"
        className="flex flex-col gap-0 p-0 sm:max-w-[500px]"
      >
        <SheetHeader className="border-b px-6 py-5">
          <SheetTitle className="text-base">{t("models.add.title")}</SheetTitle>
          <SheetDescription className="text-xs">
            {t("models.add.description")}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-5 px-6 py-5">
            {/* ── Required basic fields ── */}
            <Field label={t("models.add.modelName")}>
              <Input
                value={form.modelName}
                onChange={setField("modelName")}
                placeholder={t("models.add.modelNamePlaceholder")}
                aria-invalid={!!fieldErrors.modelName}
              />
              {fieldErrors.modelName && (
                <p className="text-destructive text-xs">
                  {fieldErrors.modelName}
                </p>
              )}
              <p className="text-muted-foreground text-xs">
                {t("models.add.modelNameHint")}
              </p>
            </Field>

            <Field label={t("models.add.modelId")}>
              <Input
                value={form.model}
                onChange={setField("model")}
                placeholder={t("models.add.modelIdPlaceholder")}
                className="font-mono text-sm"
                aria-invalid={!!fieldErrors.model}
              />
              {fieldErrors.model && (
                <p className="text-destructive text-xs">{fieldErrors.model}</p>
              )}
              <p className="text-muted-foreground text-xs">
                {t("models.add.modelIdHint")}
              </p>
            </Field>

            <Field label={t("models.field.apiBase")}>
              <Input
                value={form.apiBase}
                onChange={setField("apiBase")}
                placeholder="https://api.example.com/v1"
              />
            </Field>

            <Field label={t("models.field.apiKey")}>
              <KeyInput
                value={form.apiKey}
                onChange={(v) => setForm((f) => ({ ...f, apiKey: v }))}
                placeholder={t("models.field.apiKeyPlaceholder")}
              />
            </Field>

            {/* ── Advanced options ── */}
            <AdvancedSection>
              <Field
                label={t("models.field.proxy")}
                hint={t("models.field.proxyHint")}
              >
                <Input
                  value={form.proxy}
                  onChange={setField("proxy")}
                  placeholder="http://127.0.0.1:7890"
                />
              </Field>

              <Field
                label={t("models.field.authMethod")}
                hint={t("models.field.authMethodHint")}
              >
                <Input
                  value={form.authMethod}
                  onChange={setField("authMethod")}
                  placeholder="oauth"
                />
              </Field>

              <Field
                label={t("models.field.connectMode")}
                hint={t("models.field.connectModeHint")}
              >
                <Input
                  value={form.connectMode}
                  onChange={setField("connectMode")}
                  placeholder="stdio"
                />
              </Field>

              <Field
                label={t("models.field.workspace")}
                hint={t("models.field.workspaceHint")}
              >
                <Input
                  value={form.workspace}
                  onChange={setField("workspace")}
                  placeholder="/path/to/workspace"
                />
              </Field>

              <Field
                label={t("models.field.requestTimeout")}
                hint={t("models.field.requestTimeoutHint")}
              >
                <Input
                  value={form.requestTimeout}
                  onChange={setField("requestTimeout")}
                  placeholder="60"
                  type="number"
                  min={0}
                />
              </Field>

              <Field
                label={t("models.field.rpm")}
                hint={t("models.field.rpmHint")}
              >
                <Input
                  value={form.rpm}
                  onChange={setField("rpm")}
                  placeholder="60"
                  type="number"
                  min={0}
                />
              </Field>

              <Field
                label={t("models.field.thinkingLevel")}
                hint={t("models.field.thinkingLevelHint")}
              >
                <Input
                  value={form.thinkingLevel}
                  onChange={setField("thinkingLevel")}
                  placeholder="off"
                />
              </Field>

              <Field
                label={t("models.field.maxTokensField")}
                hint={t("models.field.maxTokensFieldHint")}
              >
                <Input
                  value={form.maxTokensField}
                  onChange={setField("maxTokensField")}
                  placeholder="max_completion_tokens"
                />
              </Field>
            </AdvancedSection>

            {serverError && (
              <p className="text-destructive bg-destructive/10 rounded-md px-3 py-2 text-sm">
                {serverError}
              </p>
            )}
          </div>
        </div>

        <SheetFooter className="border-t px-6 py-4">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <IconLoader2 className="size-4 animate-spin" />}
            {t("models.add.confirm")}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Delete confirmation dialog
// ---------------------------------------------------------------------------

interface DeleteDialogProps {
  model: ModelInfo | null
  onClose: () => void
  onDeleted: () => void
}

function DeleteDialog({ model, onClose, onDeleted }: DeleteDialogProps) {
  const { t } = useTranslation()
  const [deleting, setDeleting] = useState(false)

  const handleConfirm = async () => {
    if (!model) return
    if (model.is_default) {
      onClose()
      return
    }
    setDeleting(true)
    try {
      await deleteModel(model.index)
      onDeleted()
    } catch {
      // ignore — list will still show; user can retry
    } finally {
      setDeleting(false)
      onClose()
    }
  }

  return (
    <AlertDialog open={model !== null} onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("models.delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("models.delete.description", { name: model?.model_name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose} disabled={deleting}>
            {t("common.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={handleConfirm}
            disabled={deleting}
          >
            {deleting && <IconLoader2 className="size-4 animate-spin" />}
            {t("models.delete.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// ---------------------------------------------------------------------------
// Model card
// ---------------------------------------------------------------------------

interface ModelCardProps {
  model: ModelInfo
  onEdit: (m: ModelInfo) => void
  onSetDefault: (m: ModelInfo) => void
  onDelete: (m: ModelInfo) => void
  settingDefault: boolean
}

function ModelCard({
  model,
  onEdit,
  onSetDefault,
  onDelete,
  settingDefault,
}: ModelCardProps) {
  const { t } = useTranslation()
  const isOAuth = model.auth_method === "oauth"

  return (
    <div
      className={[
        "group/card relative flex flex-col gap-3 rounded-xl border p-4 transition-colors",
        model.configured
          ? "border-border/60 bg-card hover:bg-muted/30"
          : "border-border/40 bg-card/60 hover:bg-muted/20",
      ].join(" ")}
    >
      {/* Top row: status dot + name + default badge */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {/* Configured indicator */}
          <span
            className={[
              "mt-0.5 h-2 w-2 shrink-0 rounded-full",
              model.configured ? "bg-green-500" : "bg-muted-foreground/25",
            ].join(" ")}
            title={
              model.configured
                ? t("models.status.configured")
                : t("models.status.unconfigured")
            }
          />
          <span className="text-foreground truncate text-sm font-semibold">
            {model.model_name}
          </span>
          {model.is_default && (
            <span className="bg-primary/10 text-primary shrink-0 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium">
              {t("models.badge.default")}
            </span>
          )}
        </div>

        {/* Action buttons — always visible on card */}
        <div className="flex shrink-0 items-center gap-0.5">
          {model.is_default ? (
            <span
              className="text-primary p-1"
              title={t("models.badge.default")}
            >
              <IconStarFilled className="size-3.5" />
            </span>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onSetDefault(model)}
              disabled={settingDefault}
              title={t("models.action.setDefault")}
            >
              {settingDefault ? (
                <IconLoader2 className="size-3.5 animate-spin" />
              ) : (
                <IconStar className="size-3.5" />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onEdit(model)}
            title={t("models.action.edit")}
          >
            <IconEdit className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onDelete(model)}
            disabled={model.is_default}
            title={t("models.action.delete")}
            className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          >
            <IconTrash className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Model identifier */}
      <p className="text-muted-foreground truncate font-mono text-xs leading-snug">
        {model.model}
      </p>

      {/* Footer row: masked key or auth badge */}
      <div className="flex items-center gap-2">
        {isOAuth ? (
          <span className="text-muted-foreground bg-muted rounded px-1.5 py-0.5 text-[10px] font-medium">
            OAuth
          </span>
        ) : model.configured && model.api_key ? (
          <span className="text-muted-foreground/70 flex items-center gap-1 font-mono text-[11px]">
            <IconKey className="size-3" />
            {model.api_key}
          </span>
        ) : (
          <span className="text-muted-foreground/50 text-[11px]">
            {t("models.status.unconfigured")}
          </span>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Provider section
// ---------------------------------------------------------------------------

interface ProviderSectionProps {
  provider: string
  models: ModelInfo[]
  onEdit: (m: ModelInfo) => void
  onSetDefault: (m: ModelInfo) => void
  onDelete: (m: ModelInfo) => void
  settingDefaultIndex: number | null
}

function ProviderSection({
  provider,
  models,
  onEdit,
  onSetDefault,
  onDelete,
  settingDefaultIndex,
}: ProviderSectionProps) {
  const configuredCount = models.filter((m) => m.configured).length

  return (
    <div className="mb-6">
      {/* Section label */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-foreground/80 text-xs font-semibold tracking-wide uppercase">
          {provider}
        </span>
        <span className="text-muted-foreground text-xs">
          {configuredCount}/{models.length}
        </span>
        <div className="border-border/40 flex-1 border-t" />
      </div>

      {/* Card grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {models.map((m) => (
          <ModelCard
            key={m.index}
            model={m}
            onEdit={onEdit}
            onSetDefault={onSetDefault}
            onDelete={onDelete}
            settingDefault={settingDefaultIndex === m.index}
          />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function ModelsPage() {
  const { t } = useTranslation()
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState("")

  const [editingModel, setEditingModel] = useState<ModelInfo | null>(null)
  const [deletingModel, setDeletingModel] = useState<ModelInfo | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [settingDefaultIndex, setSettingDefaultIndex] = useState<number | null>(
    null,
  )

  const fetchModels = useCallback(async () => {
    try {
      const data = await getModels()
      // Sort: default first, then configured, then by name
      const sorted = [...data.models].sort((a, b) => {
        if (a.is_default && !b.is_default) return -1
        if (!a.is_default && b.is_default) return 1
        if (a.configured && !b.configured) return -1
        if (!a.configured && b.configured) return 1
        return a.model_name.localeCompare(b.model_name)
      })
      setModels(sorted)
      setFetchError("")
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : t("models.loadError"))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  const handleSetDefault = async (model: ModelInfo) => {
    setSettingDefaultIndex(model.index)
    try {
      await setDefaultModel(model.model_name)
      await fetchModels()
    } catch {
      // ignore
    } finally {
      setSettingDefaultIndex(null)
    }
  }

  // Group by provider, preserving insertion order
  const grouped: Record<string, ModelInfo[]> = {}
  for (const m of models) {
    const p = getProviderLabel(m.model)
    if (!grouped[p]) grouped[p] = []
    grouped[p].push(m)
  }

  const defaultModel = models.find((m) => m.is_default)

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t("navigation.models", "Models")}>
        <div className="flex items-center gap-3">
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <IconPlus className="size-4" />
            {t("models.add.button")}
          </Button>
        </div>
      </PageHeader>

      {/* ── scrollable body ── */}
      {/* overflow-y-auto on this div, NOT a ScrollArea wrapper with flex-1 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
        <div className="py-5">
          {defaultModel && (
            <div className="text-muted-foreground flex items-center gap-1.5 text-sm">
              <IconStarFilled className="size-3.5" />
              {t("models.currentDefault")}{" "}
              <span className="text-primary font-medium">
                {defaultModel.model_name}
              </span>
            </div>
          )}
          <p className="text-muted-foreground mt-1 text-sm">
            {t("models.description")}
          </p>
        </div>

        {loading && (
          <div className="flex items-center justify-center py-20">
            <IconLoader2 className="text-muted-foreground size-6 animate-spin" />
          </div>
        )}

        {fetchError && (
          <div className="text-destructive bg-destructive/10 rounded-lg px-4 py-3 text-sm">
            {fetchError}
          </div>
        )}

        {!loading && !fetchError && (
          <div className="pt-2 pb-8">
            {Object.entries(grouped).map(([provider, providerModels]) => (
              <ProviderSection
                key={provider}
                provider={provider}
                models={providerModels}
                onEdit={setEditingModel}
                onSetDefault={handleSetDefault}
                onDelete={setDeletingModel}
                settingDefaultIndex={settingDefaultIndex}
              />
            ))}
          </div>
        )}
      </div>

      <EditSheet
        model={editingModel}
        open={editingModel !== null}
        onClose={() => setEditingModel(null)}
        onSaved={fetchModels}
      />

      <AddSheet
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={fetchModels}
      />

      <DeleteDialog
        model={deletingModel}
        onClose={() => setDeletingModel(null)}
        onDeleted={fetchModels}
      />
    </div>
  )
}
