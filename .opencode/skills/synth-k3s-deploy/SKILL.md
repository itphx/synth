---
name: synth-k3s-deploy
description: Managed-деплой Synth в K3s (Rancher Fleet): test-инстанс, preprod, prod, helm-чарт, адреса, Keycloak, kubectl-доступ. Используй при работе с инстансами Synth.
---

# K3s-инстанс (managed-деплой)

Текущий managed-инстанс — **среда test** (внутренний тестовый). Он развёрнут в K3s (Rancher Fleet) на `itphx.loc`. Код приложения — в монорепо `synth/`, код деплоя test-среды — в отдельном git-репозитории `synth-deploy/` (каталог рядом с `synth/`).

## Среды

| Среда | Адрес | Как разворачивается |
|-------|-------|---------------------|
| **test** | https://synth.k3s.itphx.loc | Fleet (`synth-deploy`), образы собираются локально и пушатся в `git.itphx.ru` |
| **preprod** | https://synth-release.k3s.itphx.loc | публикуемый Helm-чарт (GitVerse), релизные образы `gitverse.ru` |
| **prod** | у нас отсутствует — разворачивают клиенты/заказчики сами | публикуемый Helm-чарт (self-host) |

preprod и prod ставятся из опубликованного Helm-чарта (`helm repo add synth https://gitverse.ru/api/packages/itphx/helm`), **не** через Fleet.

## Репозиторий деплоя (test)

Fleet-деплой **test-среды** (namespace `synth`).

- Helm-чарт + Fleet-конфиг: `Chart.yaml`, `values.yaml`, `fleet.yaml`, `templates/` (namespace `synth`)
- Fleet-репозиторий: `https://git.itphx.ru/itphx/synth-deploy.git`, ветка `main`
- Подробности: `synth-deploy/README.md`

## Адреса (test)

| Сервис | Адрес |
|--------|-------|
| Synth UI (вход) | https://synth.k3s.itphx.loc |
| Keycloak issuer | https://keycloak.itphx.loc/realms/synth (клиент `synth`, confidential) |
| Backend в кластере | `synth-backend:5000` (namespace `synth`) |

Доступ к кластеру: `kubectl` (контекст `local`), поды/логи — `kubectl -n synth get pods`, `kubectl -n synth logs deploy/synth-backend`.

## Учётные записи Keycloak

Тестовая УЗ (realm `synth`, роль `user`) и временная админская УЗ (realm `master`) — в файле `secrets/keycloak-accounts.md` в корне проекта, вне git-репозитория `synth/`.

Временная админская УЗ используется для admin API Keycloak (`admin-cli`) — например, для диагностики ролей и мапперов. Client secret клиента `synth` — в SealedSecret `synth-secrets` (namespace `synth`, ключ `SYNTH_OIDC_CLIENT_SECRET`), команда для получения — в файле секретов.
