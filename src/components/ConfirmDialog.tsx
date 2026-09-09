import { useT } from '@/hooks/useT'

interface Props {
  title: string
  message: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
}

/** 通用确认对话框（删除等破坏性操作）。样式取自 AIPanel 原有的删除会话确认弹层。 */
export function ConfirmDialog({ title, message, onConfirm, onCancel, danger = true }: Props) {
  const { t } = useT()
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[300]" onClick={onCancel}>
      <div
        className="bg-[var(--canvas-card)] border border-[var(--hairline)] rounded-xl p-6 w-[360px] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[16px] font-medium text-[var(--ink)] mb-2">{title}</h3>
        <p className="text-[13px] text-[var(--ink-tertiary)] mb-5">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            className="h-[32px] px-4 rounded-lg border border-[var(--hairline-light)] bg-[var(--canvas-elevated)] text-[var(--ink)] text-[13px] cursor-pointer hover:bg-[var(--canvas-mid)]"
            onClick={onCancel}
          >
            {t('common.cancel')}
          </button>
          <button
            className={`h-[32px] px-4 rounded-lg text-white text-[13px] font-medium cursor-pointer border-none hover:brightness-110 ${danger ? 'bg-[var(--error)]' : 'bg-[var(--accent-gold)]'}`}
            onClick={onConfirm}
          >
            {t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
