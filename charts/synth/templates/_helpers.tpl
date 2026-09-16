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
