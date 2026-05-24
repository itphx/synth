import { useEffect, useRef } from 'react';
import type { DebugData } from '../../stores/chatStore';

interface DebugModalProps {
  debug: DebugData;
  onClose: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="border-b border-border/30 pb-2 mb-2">
      <summary className="text-sm font-medium cursor-pointer select-none py-1">{title}</summary>
      <div className="mt-1 text-xs">{children}</div>
    </details>
  );
}

function JsonBlock({ data }: { data: unknown }) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return (
    <pre className="bg-muted/30 rounded p-2 overflow-auto max-h-64 text-[11px] leading-relaxed whitespace-pre-wrap">
      {text}
    </pre>
  );
}

function KeyValue({ label, value }: { label: string; value: string | number | undefined | null }) {
  if (value === undefined || value === null || value === '') return null;
  return (
    <div className="flex gap-2">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className="truncate">{String(value)}</span>
    </div>
  );
}

export function DebugModal({ debug, onClose }: DebugModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  const sessionInfo = debug.session as Record<string, unknown> | undefined;
  const apiRequest = debug.api_request as Record<string, unknown> | undefined;
  const apiResponse = debug.api_response as Record<string, unknown> | undefined;
  const rawResponse = debug.raw_model_response as string | undefined;
  const reasoning = debug.reasoning as string | undefined;
  const systemPromptParts = debug.system_prompt_parts as Record<string, unknown> | undefined;
  const contextFiles = debug.context_files as Array<Record<string, unknown>> | undefined;
  const extraContext = debug.extra_context as Record<string, unknown> | undefined;
  const subagents = debug.subagents as Array<Record<string, unknown>> | undefined;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={handleOverlayClick}
    >
      <div className="bg-background border rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col m-4">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h2 className="text-lg font-semibold">Debug — отладочная информация</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1 rounded"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto px-4 py-2">
          {/* Session Info */}
          {sessionInfo && (
            <Section title="Информация о запросе">
              <KeyValue label="Session" value={sessionInfo.session_id as string} />
              <KeyValue label="Model" value={sessionInfo.model as string} />
              <KeyValue label="Provider" value={sessionInfo.provider as string} />
              <KeyValue label="Provider type" value={sessionInfo.provider_type as string} />
              <KeyValue label="TSM mode" value={sessionInfo.tsm_mode as string} />
              <KeyValue label="Debug enabled" value={String(sessionInfo.debug_enabled)} />
            </Section>
          )}

          {/* System Prompt */}
          {systemPromptParts && (
            <Section title="System Prompt (по частям)">
              {Object.entries(systemPromptParts).map(([key, val]) => (
                <div key={key} className="mb-1">
                  <span className="text-muted-foreground">{key}</span>
                  <JsonBlock data={val} />
                </div>
              ))}
            </Section>
          )}

          {/* Context Files */}
          {contextFiles && contextFiles.length > 0 && (
            <Section title={`Файлы контекста (${contextFiles.length})`}>
              <div className="space-y-1">
                {contextFiles.map((f, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-muted-foreground shrink-0">{String(f.filename || '?')}</span>
                    <span className="text-muted-foreground/50">
                      {String(f.size || 0)} б · {String(f.source || '?')}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* API Request */}
          {apiRequest && (
            <Section title="API Запрос">
              <KeyValue label="URL" value={apiRequest.url as string} />
              <KeyValue label="Method" value={apiRequest.method as string} />
              {apiRequest.headers != null && (
                <details className="mt-1">
                  <summary className="text-muted-foreground cursor-pointer text-xs">Headers</summary>
                  <JsonBlock data={apiRequest.headers} />
                </details>
              )}
              {apiRequest.body != null && (
                <details className="mt-1">
                  <summary className="text-muted-foreground cursor-pointer text-xs">Body</summary>
                  <JsonBlock data={apiRequest.body} />
                </details>
              )}
            </Section>
          )}

          {/* Raw Response */}
          {rawResponse && (
            <Section title="Сырой ответ модели">
              <JsonBlock data={rawResponse} />
            </Section>
          )}

          {/* Reasoning */}
          {reasoning && (
            <Section title="Рассуждения (Reasoning)">
              <div className="whitespace-pre-wrap bg-muted/30 rounded p-2 text-[11px] max-h-48 overflow-auto">
                {reasoning}
              </div>
            </Section>
          )}

          {/* API Response */}
          {apiResponse && (
            <Section title="API Ответ">
              <JsonBlock data={apiResponse} />
            </Section>
          )}

          {/* Subagents */}
          {subagents && subagents.length > 0 && (
            <Section title={`Саб-агенты (${subagents.length})`}>
              {subagents.map((sa, i) => (
                <details key={i} className="border border-border/20 rounded p-2 mb-1">
                  <summary className="text-xs font-medium cursor-pointer">
                    {String(sa.name || `Subagent #${i}`)}
                  </summary>
                  <div className="mt-1 space-y-1">
                    {sa.prompt != null && (
                      <div>
                        <span className="text-muted-foreground text-[10px] uppercase">Prompt</span>
                        <div className="whitespace-pre-wrap text-[11px]">{String(sa.prompt).slice(0, 500)}</div>
                      </div>
                    )}
                    {sa.response != null && (
                      <div>
                        <span className="text-muted-foreground text-[10px] uppercase">Response</span>
                        <div className="whitespace-pre-wrap text-[11px]">{String(sa.response).slice(0, 500)}</div>
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </Section>
          )}

          {/* Extra Context */}
          {extraContext && Object.keys(extraContext).length > 0 && (
            <Section title="Дополнительный контекст">
              <JsonBlock data={extraContext} />
            </Section>
          )}
        </div>

        <div className="px-4 py-2 border-t flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-primary text-primary-foreground rounded text-sm hover:opacity-90"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
