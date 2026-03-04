# Repo Hygiene Policy (Fase 0)

## Objetivo
Mantener el repositorio desplegable, reproducible y libre de artefactos operativos/temporales.

## Reglas
1. No versionar archivos temporales (`tmp_*`), backups (`*.bak*`) ni archivos `.disabled`.
2. No versionar bases locales (`*.sqlite*`) ni runtime-state (`runtime-settings.json`).
3. Cualquier script de emergencia debe vivir fuera del repo o en carpeta `ops/` con nombre estable y documentación.
4. Toda limpieza se hace por PR con diff auditable.

## Checklist pre-merge
- [ ] No hay `tmp_*`
- [ ] No hay `.bak*` / `.disabled`
- [ ] No hay secretos en texto plano
- [ ] `.gitignore` actualizado
- [ ] `verify` ejecutado
