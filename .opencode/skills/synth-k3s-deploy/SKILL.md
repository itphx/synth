---
name: synth-k3s-deploy
description: Managed-деплой Synth в K3s (Rancher Fleet): helm-чарт, адреса, Keycloak, kubectl-доступ. Используй при работе с боевым инстансом.
---

# K3s-инстанс (managed-деплой)

Боевой инстанс развёрнут в K3s (Rancher Fleet) на `itphx.loc`. Код приложения — в монорепо `synth/`, код деплоя — в отдельном git-репозитории `synth-deploy/` (каталог рядом с `synth/`).

## Репозиторий деплоя

- Helm-чарт + Fleet-конфиг: `Chart.yaml`, `values.yaml`, `fleet.yaml`, `templates/` (namespace `synth`)
- Fleet-репозиторий: `https://git.itphx.ru/itphx/synth-deploy.git`, ветка `main`
- Подробности: `synth-deploy/README.md`

## Адреса

| Сервис | Адрес |
|--------|-------|
| Synth UI (вход) | https://synth.k3s.itphx.loc |
| Keycloak issuer | https://keycloak.itphx.loc/realms/synth (клиент `synth`, confidential) |
| Backend в кластере | `synth-backend:5000` (namespace `synth`) |

Доступ к кластеру: `kubectl` (контекст `local`), поды/логи — `kubectl -n synth get pods`, `kubectl -n synth logs deploy/synth-backend`.

## Учётные записи Keycloak

Тестовая УЗ (realm `synth`, роль `user`) и временная админская УЗ (realm `master`) — в файле `secrets/keycloak-accounts.md` в корне проекта, вне git-репозитория `synth/`.

Временная админская УЗ используется для admin API Keycloak (`admin-cli`) — например, для диагностики ролей и мапперов. Client secret клиента `synth` — в SealedSecret `synth-secrets` (namespace `synth`, ключ `SYNTH_OIDC_CLIENT_SECRET`), команда для получения — в файле секретов.
