{{/* ---------------------------------------------------------------------------
vteam 名称 / 标签 / secret 引用 / 随机值缓存 辅助模板
--------------------------------------------------------------------------- */}}

{{/*
Expand the name of the chart.
*/}}
{{- define "vteam.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this.
*/}}
{{- define "vteam.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
组件 selector labels。用法：
  {{- include "vteam.matchLabels" (dict "context" . "component" "server") | nindent 6 }}
*/}}
{{- define "vteam.matchLabels" -}}
{{- $c := .context -}}
app.kubernetes.io/name: {{ include "vteam.name" $c }}
app.kubernetes.io/instance: {{ $c.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
完整 labels（含 chart 版本 / app 版本 / 管理方）。
*/}}
{{- define "vteam.labels" -}}
{{- $c := .context -}}
helm.sh/chart: {{ printf "%s-%s" $c.Chart.Name $c.Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "vteam.matchLabels" . }}
app.kubernetes.io/version: {{ $c.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ $c.Release.Service }}
{{- end }}

{{/*
组件资源名。
*/}}
{{- define "vteam.server.name" -}}{{ include "vteam.fullname" . }}-server{{- end }}
{{- define "vteam.web.name" -}}{{ include "vteam.fullname" . }}-web{{- end }}
{{- define "vteam.worker.name" -}}{{ include "vteam.fullname" . }}-worker{{- end }}
{{- define "vteam.mysql.name" -}}{{ include "vteam.fullname" . }}-mysql{{- end }}
{{- define "vteam.init.name" -}}{{ include "vteam.fullname" . }}-init{{- end }}
{{- define "vteam.config.name" -}}{{ include "vteam.fullname" . }}-config{{- end }}
{{- define "vteam.secret.name" -}}{{ include "vteam.fullname" . }}-secret{{- end }}

{{/*
Secret 引用名：existingSecret 优先，否则自建 Secret。
*/}}
{{- define "vteam.secretName" -}}
{{- if .Values.secret.existingSecret }}
{{- .Values.secret.existingSecret }}
{{- else }}
{{- include "vteam.secret.name" . }}
{{- end }}
{{- end }}

{{/*
----------------------------------------------------------------------------
共享随机值缓存。
secret.yaml 与 configmap.yaml（拼装 DATABASE_URL）必须引用同一个生成值，
故在根 context 上 set 一次缓存（后续 include 复用；用户显式提供则取用户值）。
---------------------------------------------------------------------------- */}}

{{- define "vteam.dbPassword" -}}
{{- if .Values.secret.dbPassword }}
{{- .Values.secret.dbPassword }}
{{- else }}
{{- $_ := set . "vteamDbPassword" (default (randAlphaNum 16) .vteamDbPassword) }}
{{- .vteamDbPassword }}
{{- end }}
{{- end }}

{{- define "vteam.jwtSecret" -}}
{{- if .Values.secret.jwtSecret }}
{{- .Values.secret.jwtSecret }}
{{- else }}
{{- $_ := set . "vteamJwtSecret" (default (randAlphaNum 32) .vteamJwtSecret) }}
{{- .vteamJwtSecret }}
{{- end }}
{{- end }}

{{- define "vteam.workerToken" -}}
{{- if .Values.secret.workerToken }}
{{- .Values.secret.workerToken }}
{{- else }}
{{- $_ := set . "vteamWorkerToken" (default (randAlphaNum 32) .vteamWorkerToken) }}
{{- .vteamWorkerToken }}
{{- end }}
{{- end }}

{{- define "vteam.modelKey" -}}
{{- if .Values.secret.modelCredentialKey }}
{{- .Values.secret.modelCredentialKey }}
{{- else }}
{{- $_ := set . "vteamModelKey" (default (randAlphaNum 32) .vteamModelKey) }}
{{- .vteamModelKey }}
{{- end }}
{{- end }}

{{/*
镜像完整名：registry 前缀已含在 repository（如 docker.ketaops.cc/ketaops/vteam-server）。
*/}}
{{- define "vteam.image" -}}
{{- $img := index . 0 -}}
{{- $ctx := index . 1 -}}
{{- printf "%s:%s" $img.repository ($img.tag | default $ctx.Chart.AppVersion) -}}
{{- end }}
