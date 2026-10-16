{{- define "synth.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "synth.backend.fullname" -}}
{{- if .Values.backend.fullnameOverride }}
{{- .Values.backend.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- default "synth-backend" .Values.backend.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "synth.ui.fullname" -}}
{{- if .Values.ui.fullnameOverride }}
{{- .Values.ui.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- default "synth-ui" .Values.ui.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "synth.labels" -}}
helm.sh/chart: {{ include "synth.name" . }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "synth.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "synth.backend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "synth.name" . }}
app.kubernetes.io/component: backend
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "synth.ui.selectorLabels" -}}
app.kubernetes.io/name: {{ include "synth.name" . }}
app.kubernetes.io/component: ui
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "synth.envName" -}}
{{- .name | upper | replace "-" "_" }}
{{- end }}

{{- /* PROP-032: chart-значения storage.* отличаются от дефолта (backend != file
       либо задан задел деградации) → секцию storage нужно домержить в
       config.yaml. Возвращает "true" или пустую строку. */ -}}
{{- define "synth.storage.inConfig" -}}
{{- $s := .Values.storage | default dict -}}
{{- if or (ne ($s.backend | default "file") "file") $s.degradedMode $s.fallbackDir -}}true{{- end -}}
{{- end -}}

{{- /* PROP-032: ConfigMap <release>-config нужен, если задан backend.config
       ИЛИ домерживается storage.* (иначе монтировать нечего). */ -}}
{{- define "synth.backend.hasConfigMap" -}}
{{- if or .Values.backend.config (include "synth.storage.inConfig" .) -}}true{{- end -}}
{{- end -}}

{{- /* PROP-032: активен ли postgres-backend (нужен ли env с паролем БД). */ -}}
{{- define "synth.storage.isPostgres" -}}
{{- $s := .Values.storage | default dict -}}
{{- if eq ($s.backend | default "file") "postgres" -}}true{{- end -}}
{{- end -}}

{{- /* PROP-032: итоговый config.yaml backend = backend.config, поверх которого
       домерживается секция storage (chart-значения storage.* приоритетнее
       backend.config.storage.*). Пароль БД сюда НЕ попадает (инвариант 13) —
       он идёт только в env SYNTH_POSTGRES_PASSWORD из Secret. */ -}}
{{- define "synth.backend.configYaml" -}}
{{- /* Без chart-значений storage.* итоговый config.yaml = backend.config как есть
       (поведение чарта не меняется, включая строковую форму от --set-file). */ -}}
{{- $cfg := .Values.backend.config | default dict -}}
{{- if include "synth.storage.inConfig" . -}}
{{- /* Перед домержем storage нужен объект: от --set-file backend.config приходит
       строкой YAML — парсим; модифицировать .Values нельзя (deepCopy). */ -}}
{{- if kindIs "string" $cfg -}}
{{- $parsed := $cfg | fromYaml -}}
{{- if not (kindIs "map" $parsed) -}}
{{- fail "backend.config: строка не является YAML-объектом — секцию storage домержить некуда" -}}
{{- end -}}
{{- if hasKey $parsed "Error" -}}
{{- /* sprig fromYaml возвращает {Error: "…"} при невалидном YAML. */ -}}
{{- fail (printf "backend.config: невалидный YAML (%v)" (index $parsed "Error")) -}}
{{- end -}}
{{- $cfg = $parsed -}}
{{- else -}}
{{- $cfg = deepCopy $cfg -}}
{{- end -}}
{{- $s := .Values.storage | default dict -}}
{{- $isPg := eq ($s.backend | default "file") "postgres" -}}
{{- $pgSrc := $s.postgres | default dict -}}
{{- $pg := dict -}}
{{- if $isPg -}}
{{- with $pgSrc.host }}{{ $_ := set $pg "host" . }}{{ end -}}
{{- with $pgSrc.port }}{{ $_ := set $pg "port" . }}{{ end -}}
{{- with $pgSrc.database }}{{ $_ := set $pg "database" . }}{{ end -}}
{{- with $pgSrc.user }}{{ $_ := set $pg "user" . }}{{ end -}}
{{- with $pgSrc.schema }}{{ $_ := set $pg "schema" . }}{{ end -}}
{{- with $pgSrc.poolMax }}{{ $_ := set $pg "poolMax" . }}{{ end -}}
{{- if $pgSrc.ssl }}{{ $_ := set $pg "ssl" true }}{{ end -}}
{{- end -}}
{{- $storageCfg := dict "backend" ($s.backend | default "file") -}}
{{- if $pg }}{{ $_ := set $storageCfg "postgres" $pg }}{{ end -}}
{{- with $s.degradedMode }}{{ $_ := set $storageCfg "degradedMode" . }}{{ end -}}
{{- with $s.fallbackDir }}{{ $_ := set $storageCfg "fallbackDir" . }}{{ end -}}
{{- $_ := set $cfg "storage" (mergeOverwrite ($cfg.storage | default dict) $storageCfg) -}}
{{- end -}}
{{- toYaml $cfg -}}
{{- end }}
