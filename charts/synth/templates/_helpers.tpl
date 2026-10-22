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

{{- /* PROP-077: исполнитель (worker) — пул контейнеров с toolchain'ом. */ -}}
{{- define "synth.executor.fullname" -}}
{{- if .Values.executor.fullnameOverride }}
{{- .Values.executor.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- default "synth-executor" .Values.executor.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- define "synth.executor.selectorLabels" -}}
app.kubernetes.io/name: {{ include "synth.name" . }}
app.kubernetes.io/component: executor
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- /* PROP-077: адрес Service пула исполнителей (control plane ходит сюда). */ -}}
{{- define "synth.executor.serviceUrl" -}}
{{- printf "http://%s:%d" (include "synth.executor.fullname" .) (.Values.executor.service.port | int64) -}}
{{- end }}

{{- /* PROP-077: общий том workspace включён? (управляется чартом). */ -}}
{{- define "synth.executor.workspaceEnabled" -}}
{{- $w := .Values.executor.workspace | default dict -}}
{{- if $w.enabled -}}true{{- end -}}
{{- end }}

{{- /* PROP-077: claim общего тома workspace (существующий или созданный чартом). */ -}}
{{- define "synth.executor.workspaceClaim" -}}
{{- $w := .Values.executor.workspace | default dict -}}
{{- $w.existingClaim | default $w.claimName | default (printf "%s-workspace" (include "synth.executor.fullname" .)) -}}
{{- end }}

{{- /* PROP-077: режим исполнения (fail-closed на неизвестном значении). */ -}}
{{- define "synth.execution.mode" -}}
{{- $m := (((.Values.execution | default dict).mode) | default "inline") | toString -}}
{{- if not (has $m (list "inline" "remote")) -}}
{{- fail (printf "execution.mode: ожидается \"inline\" или \"remote\", получено %q" $m) -}}
{{- end -}}
{{- $m -}}
{{- end }}

{{- /* PROP-077: удалённый режим (split-топология) включён? */ -}}
{{- define "synth.execution.isRemote" -}}
{{- if eq (include "synth.execution.mode" .) "remote" -}}true{{- end -}}
{{- end }}

{{- /* PROP-077: поведение при недоступном исполнителе (fail-closed по умолчанию). */ -}}
{{- define "synth.execution.failMode" -}}
{{- $fm := ((((.Values.execution | default dict).remote | default dict).failMode) | default "fail") | toString -}}
{{- if not (has $fm (list "fail" "inline-fallback")) -}}
{{- fail (printf "execution.remote.failMode: ожидается \"fail\" или \"inline-fallback\", получено %q" $fm) -}}
{{- end -}}
{{- $fm -}}
{{- end }}

{{- /* PROP-077: список адресов исполнителей (через запятую — формат env).
       Пусто → адрес Service пула (если executor.enabled), иначе — ошибка
       рендера (fail-closed: без адреса удалённый режим не поднимется). */ -}}
{{- define "synth.execution.remoteUrls" -}}
{{- $r := (.Values.execution | default dict).remote | default dict -}}
{{- $raw := $r.url | default list -}}
{{- $urls := $raw -}}
{{- if kindIs "string" $raw -}}
{{- $urls = list $raw -}}
{{- end -}}
{{- if not $urls -}}
{{- if .Values.executor.enabled -}}
{{- $urls = list (include "synth.executor.serviceUrl" .) -}}
{{- else -}}
{{- fail "execution.mode: remote — задайте execution.remote.url (список адресов исполнителей) или включите executor.enabled: true (тогда чарт подставит адрес Service пула)" -}}
{{- end -}}
{{- end -}}
{{- $urls | join "," -}}
{{- end }}

{{- /* PROP-077: Secret с токеном доверия — один на control plane и исполнителя. */ -}}
{{- define "synth.execution.tokenSecretName" -}}
{{- $t := .Values.executor.token | default dict -}}
{{- $t.existingSecret | default .Values.secrets.existingSecret -}}
{{- end }}

{{- /* PROP-077: ключ токена внутри Secret. */ -}}
{{- define "synth.execution.tokenKey" -}}
{{- $t := .Values.executor.token | default dict -}}
{{- $t.secretKey | default "SYNTH_EXECUTION_TOKEN" -}}
{{- end }}

{{- /* PROP-077: каталог монтирования Secret с токеном в backend. */ -}}
{{- define "synth.execution.tokenMountDir" -}}
/etc/synth/executor
{{- end }}

{{- /* PROP-077: путь к файлу с токеном (control plane читает токен из файла —
       значение токена в env/ConfigMap не попадает, инвариант 13). */ -}}
{{- define "synth.execution.tokenFilePath" -}}
{{- include "synth.execution.tokenMountDir" . }}/token
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

{{- /* PROP-032/ADR-099: ConfigMap <release>-config нужен, если задан backend.config
       ИЛИ домерживаются security.tls (ADR-099) / storage.* (PROP-032). */ -}}
{{- define "synth.backend.hasConfigMap" -}}
{{- if or .Values.backend.config (include "synth.storage.inConfig" .) (include "synth.tls.inConfig" .) -}}true{{- end -}}
{{- end -}}

{{- /* PROP-032: активен ли postgres-backend (нужен ли env с паролем БД). */ -}}
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

{{- /* PROP-032: итоговый config.yaml backend = backend.config, поверх которого
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
