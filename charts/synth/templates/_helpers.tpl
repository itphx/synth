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

{{- /* ADR-096: chart-значения storage.* отличаются от дефолта (backend != file
       либо задан задел деградации) → секцию storage нужно домержить в
       config.yaml. Возвращает "true" или пустую строку. */ -}}
{{- define "synth.storage.inConfig" -}}
{{- $s := .Values.storage | default dict -}}
{{- if or (ne ($s.backend | default "file") "file") $s.degradedMode $s.fallbackDir -}}true{{- end -}}
{{- end -}}

{{- /* ADR-096/ADR-099: ConfigMap <release>-config нужен, если задан backend.config
       ИЛИ домерживаются security.tls (ADR-099) / storage.* (ADR-096). */ -}}
{{- define "synth.backend.hasConfigMap" -}}
{{- if or .Values.backend.config (include "synth.storage.inConfig" .) (include "synth.tls.inConfig" .) -}}true{{- end -}}
{{- end -}}

{{- /* ADR-097: активен ли postgres-backend (нужен ли env с паролем БД). */ -}}
{{- define "synth.storage.isPostgres" -}}
{{- $s := .Values.storage | default dict -}}
{{- if eq ($s.backend | default "file") "postgres" -}}true{{- end -}}
{{- end -}}

{{- /* ADR-099: каталог монтирования Secret с CA/клиентскими сертификатами. */ -}}
{{- define "synth.backend.tlsMountDir" -}}
/etc/synth/tls
{{- end -}}

{{- /* ADR-099: Secret с CA/клиентскими сертификатами монтируется в backend. */ -}}
{{- define "synth.tls.mounted" -}}
{{- $t := .Values.security.tls | default dict -}}
{{- if $t.existingSecret -}}true{{- end -}}
{{- end -}}

{{- /* ADR-099: секция security.tls задана → её нужно домержить в config.yaml. */ -}}
{{- define "synth.tls.inConfig" -}}
{{- $t := .Values.security.tls | default dict -}}
{{- if or $t.existingSecret $t.caFile $t.certFile $t.keyFile $t.rejectUnauthorized -}}true{{- end -}}
{{- end -}}

{{- /* ADR-099: секция security.tls для config.yaml — ТОЛЬКО пути внутри
       контейнера (никаких PEM/ключей, инвариант 13). Явный путь приоритетнее
       выведенного из ключа Secret. Пустая секция → пустой dict. */ -}}
{{- define "synth.security.tlsYaml" -}}
{{- $t := .Values.security.tls | default dict -}}
{{- $dir := include "synth.backend.tlsMountDir" . -}}
{{- $mounted := include "synth.tls.mounted" . -}}
{{- $ca := $t.caFile -}}
{{- if and (not $ca) $mounted $t.caKey -}}{{- $ca = printf "%s/%s" $dir $t.caKey -}}{{- end -}}
{{- $cert := $t.certFile -}}
{{- if and (not $cert) $mounted $t.certKey -}}{{- $cert = printf "%s/%s" $dir $t.certKey -}}{{- end -}}
{{- $key := $t.keyFile -}}
{{- if and (not $key) $mounted $t.keyKey -}}{{- $key = printf "%s/%s" $dir $t.keyKey -}}{{- end -}}
{{- $tls := dict -}}
{{- with $ca }}{{ $_ := set $tls "caFile" . }}{{ end -}}
{{- with $cert }}{{ $_ := set $tls "certFile" . }}{{ end -}}
{{- with $key }}{{ $_ := set $tls "keyFile" . }}{{ end -}}
{{- with $t.rejectUnauthorized -}}
{{- $v := lower (toString .) -}}
{{- if eq $v "true" }}{{ $_ := set $tls "rejectUnauthorized" true -}}
{{- else if eq $v "false" }}{{ $_ := set $tls "rejectUnauthorized" false -}}
{{- else }}{{ fail (printf "security.tls.rejectUnauthorized: ожидается \"true\" или \"false\", получено %q" .) }}{{ end -}}
{{- end -}}
{{- toYaml $tls -}}
{{- end }}

{{- /* ADR-096: итоговый config.yaml backend = backend.config, поверх которого
       домерживается секция storage (chart-значения storage.* приоритетнее
       backend.config.storage.*). Пароль БД сюда НЕ попадает (инвариант 13) —
       он идёт только в env SYNTH_POSTGRES_PASSWORD из Secret.
       ADR-099: так же домерживается security.tls (только пути). */ -}}
{{- define "synth.backend.configYaml" -}}
{{- /* Без chart-значений storage + security.tls итоговый config.yaml =
       backend.config как есть (поведение чарта не меняется, включая строковую
       форму от --set-file). */ -}}
{{- $cfg := .Values.backend.config | default dict -}}
{{- $storageMerge := include "synth.storage.inConfig" . -}}
{{- $tlsMerge := include "synth.tls.inConfig" . -}}
{{- if or $storageMerge $tlsMerge -}}
{{- /* Перед домержем нужен объект: от --set-file backend.config приходит
       строкой YAML — парсим; модифицировать .Values нельзя (deepCopy). */ -}}
{{- if kindIs "string" $cfg -}}
{{- $parsed := $cfg | fromYaml -}}
{{- if not (kindIs "map" $parsed) -}}
{{- fail "backend.config: строка не является YAML-объектом — секции chart-значений домержить некуда" -}}
{{- end -}}
{{- if hasKey $parsed "Error" -}}
{{- /* sprig fromYaml возвращает {Error: "…"} при невалидном YAML. */ -}}
{{- fail (printf "backend.config: невалидный YAML (%v)" (index $parsed "Error")) -}}
{{- end -}}
{{- $cfg = $parsed -}}
{{- else -}}
{{- $cfg = deepCopy $cfg -}}
{{- end -}}
{{- if $storageMerge -}}
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
{{- if $tlsMerge -}}
{{- $securityCfg := mergeOverwrite ($cfg.security | default dict) (dict "tls" (include "synth.security.tlsYaml" . | fromYaml)) -}}
{{- $_ := set $cfg "security" $securityCfg -}}
{{- end -}}
{{- end -}}
{{- toYaml $cfg -}}
{{- end }}
