"""
AWS SSM Parameter Store helper — controler

Uso:
    from core.ssm import load_ssm_into_env, get_ssm_param

    # Chamar no startup, antes de ler os.getenv():
    load_ssm_into_env("/openclaws/")

Comportamento:
    - Cache em memoria com TTL de 5 min
    - Retry com backoff exponencial (3 tentativas)
    - Em dev (AWS_SSM_ENABLED != "true"), retorna de os.environ sem SSM
    - Converte ultimo segmento do path SSM em ENV_VAR maiusculo
"""

import os
import json
import time
import logging
from typing import Optional

logger = logging.getLogger(__name__)

REGION = os.environ.get("AWS_REGION", "us-east-1")
SSM_ENABLED = os.environ.get("AWS_SSM_ENABLED", "true").lower() == "true"
CACHE_TTL = 5 * 60

_cache: dict = {}
_client = None


def _cache_get(name: str) -> Optional[str]:
    entry = _cache.get(name)
    if not entry:
        return None
    value, expires_at = entry
    if time.time() > expires_at:
        del _cache[name]
        return None
    return value


def _cache_set(name: str, value: str) -> None:
    _cache[name] = (value, time.time() + CACHE_TTL)


def _get_client():
    global _client
    if _client is None:
        import boto3
        _client = boto3.client("ssm", region_name=REGION)
    return _client


def _retry(fn, attempts: int = 3, delay_ms: int = 200):
    last_err = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as e:
            last_err = e
            if i < attempts - 1:
                time.sleep((delay_ms * (2 ** i)) / 1000)
    raise last_err


def get_ssm_param(name: str) -> str:
    """Busca um parametro SecureString do SSM com cache de 5 min."""
    cached = _cache_get(name)
    if cached is not None:
        return cached

    if not SSM_ENABLED:
        env_key = name.split("/")[-1].upper()
        fallback = os.environ.get(env_key, "")
        return fallback

    try:
        def _fetch():
            resp = _get_client().get_parameter(Name=name, WithDecryption=True)
            return resp["Parameter"]["Value"]

        value = _retry(_fetch)
        _cache_set(name, value)
        return value

    except Exception as e:
        env_key = name.split("/")[-1].upper()
        fallback = os.environ.get(env_key, "")
        if fallback:
            logger.warning(f"[SSM] Fallback para os.environ[{env_key}] para {name}")
            return fallback
        logger.error(f"[SSM] Erro ao carregar {name}: {e}")
        return ""


def get_ssm_params_by_path(path: str) -> dict:
    """Busca todos os parametros sob um prefixo de path."""
    cache_key = f"__path__{path}"
    cached = _cache_get(cache_key)
    if cached is not None:
        return json.loads(cached)

    if not SSM_ENABLED:
        return {}

    result: dict = {}
    try:
        def _fetch():
            paginator = _get_client().get_paginator("get_parameters_by_path")
            for page in paginator.paginate(Path=path, WithDecryption=True, Recursive=True):
                for param in page.get("Parameters", []):
                    if param.get("Name") and param.get("Value"):
                        result[param["Name"]] = param["Value"]
                        _cache_set(param["Name"], param["Value"])

        _retry(_fetch)
    except Exception as e:
        logger.error(f"[SSM] Erro ao buscar path {path}: {e}")

    _cache_set(cache_key, json.dumps(result))
    return result


def load_ssm_into_env(path: str) -> None:
    """
    Carrega todos os params de um path no os.environ.
    Nomes: ultimo segmento do path SSM em maiusculo.
    Ex: /openclaws/main/gateway_token -> GATEWAY_TOKEN
    Ja existentes em os.environ sao ignorados.
    """
    if not SSM_ENABLED:
        return

    try:
        params = get_ssm_params_by_path(path)
        loaded = 0
        for name, value in params.items():
            env_key = name.split("/")[-1].upper()
            if env_key not in os.environ:
                os.environ[env_key] = value
                loaded += 1
        if loaded:
            logger.info(f"[SSM] {loaded} params carregados de {path}")
    except Exception as e:
        logger.error(f"[SSM] Erro ao carregar path {path}: {e}")
