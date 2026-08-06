# -*- coding: utf-8 -*-
"""Local API bridge for Remote API img2img helper.

The process receives commands from Photoshop JSX over localhost sockets, reads
bundled provider/model cards, encrypts API keys with Windows DPAPI, sends image
edit requests to remote providers, and writes the first returned image to a
local temporary file.
"""

from __future__ import annotations

import atexit
import base64
from contextlib import ExitStack, contextmanager
import ctypes
from ctypes import wintypes
from dataclasses import dataclass, field
import importlib
import io
import json
import logging
import math
from logging.handlers import RotatingFileHandler
import mimetypes
import os
from pathlib import Path
import queue
import re
import socket
import subprocess
import sys
import threading
import time
import traceback
import urllib.parse
import uuid
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


API_HOST = "127.0.0.1"
API_RECEIVE_PORT = 6380
API_REPLY_PORT = 6381
API_PROTOCOL = 1
VERSION = "0.1"
MAX_API_MESSAGE = 32 * 1024 * 1024
IDLE_TIMEOUT_SECONDS = 5 * 60
TEMP_MAX_AGE_SECONDS = 24 * 60 * 60

APP = {
    "name": "Remote API img2img helper",
    "slug": "remote-api-img2img-helper",
    "data_folder": "Remote API img2img helper",
    "lock_file": "remote-api-img2img.lock",
    "runtime_file": "runtime.json",
    "log_file": "remote-api-img2img.log",
}

APP_NAME = APP["name"]
SCRIPT_DIR = Path(__file__).resolve().parent


def _find_cards_dir() -> Path:
    """Find bundled cards for both supported installation layouts.

    Supported layouts:
      1. <jsx>/lib/api-img2img.pyw + <jsx>/lib/cards
      2. <jsx>/api-img2img.pyw + <jsx>/cards

    Mixed layouts are accepted as a fallback to make manual installation less
    fragile. The directory nearest to the Python API always has priority.
    """
    candidates = [
        SCRIPT_DIR / "cards",
        SCRIPT_DIR / "lib" / "cards",
    ]
    if SCRIPT_DIR.name.lower() == "lib":
        candidates.append(SCRIPT_DIR.parent / "cards")

    for candidate in candidates:
        if (candidate / "providers").is_dir() and (candidate / "models").is_dir():
            return candidate
    return candidates[0]


CARDS_DIR = _find_cards_dir()


def _local_appdata() -> Path:
    value = os.environ.get("LOCALAPPDATA")
    if value:
        return Path(value)
    return Path.home() / ".local" / "share"


APP_DIR = _local_appdata() / APP["data_folder"]
TEMP_DIR = APP_DIR / "temp"
STATE_DIR = APP_DIR / "state"
LOCK_FILE = STATE_DIR / APP["lock_file"]
RUNTIME_FILE = STATE_DIR / APP["runtime_file"]
LOG_FILE = APP_DIR / APP["log_file"]
for _directory in (APP_DIR, TEMP_DIR, STATE_DIR):
    _directory.mkdir(parents=True, exist_ok=True)


LOGGER = logging.getLogger(APP_NAME)
LOGGER.setLevel(logging.INFO)
LOGGER.propagate = False
LOGGER.handlers[:] = []
_LOG_FORMAT = logging.Formatter("%(asctime)s [%(levelname)s] %(threadName)s: %(message)s")
try:
    _file_handler = RotatingFileHandler(
        LOG_FILE,
        maxBytes=2 * 1024 * 1024,
        backupCount=2,
        encoding="utf-8",
    )
    _file_handler.setFormatter(_LOG_FORMAT)
    LOGGER.addHandler(_file_handler)
except OSError:
    pass
if sys.stderr is not None:
    _console_handler = logging.StreamHandler(sys.stderr)
    _console_handler.setFormatter(_LOG_FORMAT)
    LOGGER.addHandler(_console_handler)
if not LOGGER.handlers:
    LOGGER.addHandler(logging.NullHandler())


def log_exception(prefix: str) -> None:
    LOGGER.error("%s\n%s", prefix, traceback.format_exc())


def _subprocess_options() -> Dict[str, Any]:
    options: Dict[str, Any] = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.STDOUT,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
    }
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if creation_flags:
        options["creationflags"] = creation_flags
    return options


def _run_python_module(arguments: Sequence[str], timeout: int = 10 * 60) -> bool:
    command = [sys.executable, "-m"] + list(arguments)
    LOGGER.info("Starting Python command: %s", " ".join(command))
    try:
        completed = subprocess.run(command, timeout=timeout, **_subprocess_options())
    except Exception:
        log_exception("Could not start the Python command")
        return False
    output = str(completed.stdout or "").strip()
    if output:
        LOGGER.info("Python command output\n%s", output[-12000:])
    return completed.returncode == 0


def ensure_python_module(import_name: str, package_name: str = "") -> Any:
    try:
        return importlib.import_module(import_name)
    except ImportError:
        pass

    package = package_name or import_name
    LOGGER.info("Module %s is missing; installing %s", import_name, package)
    if not _run_python_module(["pip", "--version"], timeout=60):
        if not _run_python_module(["ensurepip", "--upgrade"], timeout=5 * 60):
            raise UserVisibleError(
                f"Could not prepare pip to install {package}. Details: {LOG_FILE}"
            )
    installed = _run_python_module(
        ["pip", "install", "--disable-pip-version-check", package]
    )
    if not installed:
        installed = _run_python_module(
            ["pip", "install", "--user", "--disable-pip-version-check", package]
        )
    if not installed:
        raise UserVisibleError(
            f"Could not automatically install {package}. Details: {LOG_FILE}"
        )
    importlib.invalidate_caches()
    try:
        return importlib.import_module(import_name)
    except ImportError as exc:
        raise UserVisibleError(
            f"{package} was installed but cannot be imported. Restart {APP_NAME}."
        ) from exc


REQUESTS: Any = None
PIL_IMAGE: Any = None
DEEP_TRANSLATOR: Any = None


def prepare_required_modules() -> None:
    global REQUESTS, PIL_IMAGE
    REQUESTS = ensure_python_module("requests")
    PIL_IMAGE = ensure_python_module("PIL.Image", "Pillow")
    LOGGER.info("Required modules are ready: requests, Pillow")


def get_translation_module() -> Any:
    global DEEP_TRANSLATOR
    if DEEP_TRANSLATOR is None:
        DEEP_TRANSLATOR = ensure_python_module("deep_translator", "deep-translator")
    return DEEP_TRANSLATOR


def api_json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def format_http_error_body(raw_body: str, limit: int = 12000) -> str:
    text = str(raw_body or "").strip()
    if not text:
        return ""
    try:
        payload = json.loads(text)
    except (TypeError, ValueError, json.JSONDecodeError):
        formatted = text
    else:
        if isinstance(payload, str):
            formatted = payload
        elif isinstance(payload, dict):
            parts: List[str] = []
            error = payload.get("error")
            if isinstance(error, dict):
                for key in ("message", "type", "code", "param"):
                    value = error.get(key)
                    if value not in (None, "", [], {}):
                        parts.append(f"{key}: {value}")
            for key in ("detail", "message", "body"):
                value = payload.get(key)
                if value in (None, "", [], {}):
                    continue
                if isinstance(value, str):
                    parts.append(value)
                else:
                    parts.append(json.dumps(value, ensure_ascii=False, indent=2))
            formatted = "\n\n".join(parts) if parts else text
        else:
            formatted = text
    formatted = formatted.replace("\r\n", "\n").replace("\r", "\n")
    formatted = formatted.replace("\t", "    ").replace("\\t", "    ")
    if len(formatted) > limit:
        formatted = formatted[:limit].rstrip() + "\n\n… message truncated"
    return formatted


def safe_filename(value: str, fallback: str = "result") -> str:
    result = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", value or "")
    result = result.strip(" ._")
    return result[:100] or fallback


def cleanup_old_temp_files() -> None:
    threshold = time.time() - TEMP_MAX_AGE_SECONDS
    try:
        for child in TEMP_DIR.iterdir():
            try:
                if child.stat().st_mtime < threshold:
                    if child.is_dir():
                        import shutil
                        shutil.rmtree(child, ignore_errors=True)
                    else:
                        child.unlink(missing_ok=True)
            except OSError:
                LOGGER.warning("Could not inspect temporary file: %s", child)
    except OSError:
        LOGGER.warning("Could not clean temporary folder %s", TEMP_DIR)


class UserVisibleError(RuntimeError):
    pass


class CancelledError(UserVisibleError):
    pass


# ---------------------------------------------------------------------------
# Windows DPAPI
# ---------------------------------------------------------------------------


class DATA_BLOB(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_byte)),
    ]


def _blob_from_bytes(data: bytes) -> Tuple[DATA_BLOB, Any]:
    buffer = ctypes.create_string_buffer(data)
    blob = DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte)))
    return blob, buffer


def _bytes_from_blob(blob: DATA_BLOB) -> bytes:
    if not blob.cbData or not blob.pbData:
        return b""
    return ctypes.string_at(blob.pbData, blob.cbData)


def _dpapi_libraries() -> Tuple[Any, Any]:
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(DATA_BLOB),
        wintypes.LPCWSTR,
        ctypes.POINTER(DATA_BLOB),
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(DATA_BLOB),
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(DATA_BLOB),
        ctypes.POINTER(wintypes.LPWSTR),
        ctypes.POINTER(DATA_BLOB),
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(DATA_BLOB),
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    return crypt32, kernel32


def dpapi_encrypt(secret: str, entropy: str = APP_NAME) -> str:
    if os.name != "nt":
        raise UserVisibleError("Secure API-key storage requires Windows DPAPI.")
    raw = secret.encode("utf-8")
    entropy_raw = entropy.encode("utf-8")
    input_blob, input_buffer = _blob_from_bytes(raw)
    entropy_blob, entropy_buffer = _blob_from_bytes(entropy_raw)
    output_blob = DATA_BLOB()
    crypt32, kernel32 = _dpapi_libraries()
    result = crypt32.CryptProtectData(
        ctypes.byref(input_blob),
        None,
        ctypes.byref(entropy_blob),
        None,
        None,
        0x01,  # CRYPTPROTECT_UI_FORBIDDEN
        ctypes.byref(output_blob),
    )
    _ = input_buffer, entropy_buffer
    if not result:
        raise UserVisibleError(
            f"Windows could not encrypt the API key (error {ctypes.get_last_error()})."
        )
    try:
        encrypted = _bytes_from_blob(output_blob)
    finally:
        kernel32.LocalFree(ctypes.cast(output_blob.pbData, ctypes.c_void_p))
    return base64.b64encode(encrypted).decode("ascii")


def dpapi_decrypt(encrypted: str, entropy: str = APP_NAME) -> str:
    if os.name != "nt":
        raise UserVisibleError("Secure API-key storage requires Windows DPAPI.")
    try:
        raw = base64.b64decode(encrypted, validate=True)
    except Exception as exc:
        raise UserVisibleError("The stored API key is damaged or has an invalid format.") from exc
    entropy_raw = entropy.encode("utf-8")
    input_blob, input_buffer = _blob_from_bytes(raw)
    entropy_blob, entropy_buffer = _blob_from_bytes(entropy_raw)
    output_blob = DATA_BLOB()
    description = wintypes.LPWSTR()
    crypt32, kernel32 = _dpapi_libraries()
    result = crypt32.CryptUnprotectData(
        ctypes.byref(input_blob),
        ctypes.byref(description),
        ctypes.byref(entropy_blob),
        None,
        None,
        0x01,
        ctypes.byref(output_blob),
    )
    _ = input_buffer, entropy_buffer
    if not result:
        raise UserVisibleError(
            "The API key could not be decrypted. It may belong to another Windows account or computer."
        )
    try:
        decrypted = _bytes_from_blob(output_blob)
    finally:
        if description:
            kernel32.LocalFree(ctypes.cast(description, ctypes.c_void_p))
        kernel32.LocalFree(ctypes.cast(output_blob.pbData, ctypes.c_void_p))
    try:
        return decrypted.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise UserVisibleError("The decrypted API key is not valid UTF-8 text.") from exc


# ---------------------------------------------------------------------------
# Bundled cards
# ---------------------------------------------------------------------------


@dataclass
class CardCatalog:
    providers: Dict[str, Dict[str, Any]]
    models: Dict[str, Dict[str, Any]]
    invalid_cards: List[Dict[str, str]]

    def public_dict(self) -> Dict[str, Any]:
        providers = [self.providers[key] for key in sorted(self.providers)]
        models = sorted(
            self.models.values(),
            key=lambda item: (str(item.get("provider")), str(item.get("label"))),
        )
        return {
            "providers": providers,
            "models": models,
            "invalid_cards": list(self.invalid_cards),
        }


def _read_json(path: Path) -> Dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise UserVisibleError(f"Could not read card: {path}\n{exc}") from exc
    except json.JSONDecodeError as exc:
        raise UserVisibleError(f"Invalid JSON in card {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise UserVisibleError(f"Card root must be an object: {path}")
    return payload


def _required_string(card: Dict[str, Any], key: str, path: Path) -> str:
    value = str(card.get(key) or "").strip()
    if not value:
        raise UserVisibleError(f"Missing field '{key}' in {path}")
    return value


def _validate_provider(card: Dict[str, Any], path: Path) -> Dict[str, Any]:
    provider_id = _required_string(card, "id", path)
    _required_string(card, "base_url", path)
    routes = card.get("routes")
    if not isinstance(routes, dict) or not routes:
        raise UserVisibleError(f"Provider {provider_id} has no routes: {path}")
    for route_id, route in routes.items():
        if not isinstance(route, dict):
            raise UserVisibleError(f"Route {route_id} must be an object: {path}")
        adapter = str(route.get("adapter") or "")
        if adapter not in ADAPTERS:
            raise UserVisibleError(f"Unknown adapter '{adapter}' in {path}")
        _required_string(route, "path", path)
        request_defaults = route.get("request_defaults")
        if request_defaults is not None and not isinstance(request_defaults, dict):
            raise UserVisibleError(f"Route {route_id} request_defaults must be an object: {path}")
        response = route.get("response")
        if response is not None:
            if not isinstance(response, dict):
                raise UserVisibleError(f"Route {route_id} response must be an object: {path}")
            for field_name in ("base64_fields", "url_fields"):
                values = response.get(field_name)
                if values is not None and (
                    not isinstance(values, list)
                    or not all(isinstance(value, str) and value for value in values)
                ):
                    raise UserVisibleError(
                        f"Route {route_id} response.{field_name} must be a string array: {path}"
                    )
    normalized = {
        "id": provider_id,
        "label": str(card.get("label") or provider_id),
        "base_url": str(card.get("base_url") or ""),
        "credentials": card.get("credentials") if isinstance(card.get("credentials"), list) else [],
        "routes": routes,
    }
    return normalized


def _validate_options(control: Dict[str, Any], name: str, path: Path) -> None:
    options = control.get("options")
    if not isinstance(options, list) or not options:
        raise UserVisibleError(f"Control {name} has no options in {path}")
    seen: set[str] = set()
    for option in options:
        if not isinstance(option, dict):
            raise UserVisibleError(f"Control {name} contains a non-object option in {path}")
        option_id = _required_string(option, "id", path)
        if option_id in seen:
            raise UserVisibleError(f"Duplicate option '{option_id}' in {path}")
        seen.add(option_id)
    default = str(control.get("default") or "")
    if default and default not in seen:
        raise UserVisibleError(f"Default option '{default}' is absent in {path}")


def _string_list(value: Any, field_name: str, path: Path) -> List[str]:
    if not isinstance(value, list) or not value:
        raise UserVisibleError(f"Field '{field_name}' must be a non-empty array in {path}")
    result: List[str] = []
    for item in value:
        text = str(item or "").strip()
        if not text:
            raise UserVisibleError(f"Field '{field_name}' contains an empty value in {path}")
        result.append(text)
    return result


def _parse_ratio_value(text: str) -> Optional[Tuple[float, float]]:
    match = re.match(r"^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$", text)
    if not match:
        return None
    try:
        a = float(match.group(1))
        b = float(match.group(2))
    except ValueError:
        return None
    if a <= 0 or b <= 0:
        return None
    return (a, b)


def _parse_size_value(text: str) -> Optional[Tuple[int, int]]:
    match = re.match(r"^\s*(\d+)\s*[xX×хХ]\s*(\d+)\s*$", text)
    if not match:
        return None
    width = int(match.group(1))
    height = int(match.group(2))
    if width <= 0 or height <= 0:
        return None
    return (width, height)


def _normalized_size_text(width: int, height: int) -> str:
    return f"{width}x{height}"


def _gcd_int(a: int, b: int) -> int:
    while b:
        a, b = b, a % b
    return abs(a) or 1


def _build_special_aspect_options() -> List[Dict[str, Any]]:
    return [
        {"id": "auto", "label": {"ru": "Авто", "en": "Auto"}, "auto_nearest": True},
        {
            "id": "selection",
            "label": {"ru": "По выделению", "en": "Match selection"},
            "selection_keep": True,
        },
    ]


def _build_aspect_options(values: Sequence[str], param: str, path: Path) -> List[Dict[str, Any]]:
    options: List[Dict[str, Any]] = _build_special_aspect_options()
    seen: set[str] = {"auto", "selection"}
    for value in values:
        raw_value = str(value or "").strip()
        ratio = _parse_ratio_value(raw_value)
        if ratio is not None:
            option_id = raw_value
            if option_id in seen:
                raise UserVisibleError(f"Duplicate aspect-ratio value '{option_id}' in {path}")
            seen.add(option_id)
            options.append({
                "id": option_id,
                "label": option_id,
                "ratio": [ratio[0], ratio[1]],
                "request": {param: option_id},
            })
            continue
        size = _parse_size_value(raw_value)
        if size is not None:
            width, height = size
            normalized = _normalized_size_text(width, height)
            if normalized in seen:
                raise UserVisibleError(f"Duplicate aspect-ratio value '{normalized}' in {path}")
            seen.add(normalized)
            divisor = _gcd_int(width, height)
            ratio_label = f"{width // divisor}:{height // divisor}"
            options.append({
                "id": normalized,
                "label": f"{ratio_label} — {width}×{height}",
                "ratio": [width, height],
                "request": {param: normalized},
            })
            continue
        option_id = raw_value
        if option_id in seen:
            raise UserVisibleError(f"Duplicate aspect-ratio value '{option_id}' in {path}")
        seen.add(option_id)
        options.append({
            "id": option_id,
            "label": option_id,
            "request": {param: option_id},
        })
    return options


def _normalize_quality_control(data: Any, path: Path, default_label: Any) -> Dict[str, Any]:
    if isinstance(data, list):
        raise UserVisibleError(f"Quality must be an object with 'param' and 'values' in {path}")
    if not isinstance(data, dict):
        raise UserVisibleError(f"Quality must be an object in {path}")
    param = _required_string(data, "param", path)
    values = _string_list(data.get("values"), "quality.values", path)
    options = []
    seen: set[str] = set()
    for value in values:
        if value in seen:
            raise UserVisibleError(f"Duplicate quality value '{value}' in {path}")
        seen.add(value)
        options.append({"id": value, "label": value, "request": {param: value}})
    default = str(data.get("default") or values[0])
    control = {"label": default_label, "default": default, "options": options}
    _validate_options(control, "quality", path)
    return control


def _normalize_size_map(size_map: Any, path: Path) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    if not isinstance(size_map, dict):
        raise UserVisibleError(f"size_map must be an object in {path}")
    param = _required_string(size_map, "param", path)
    values = size_map.get("values")
    if not isinstance(values, dict) or not values:
        raise UserVisibleError(f"size_map.values must be a non-empty object in {path}")
    quality_ids = [str(key).strip() for key in values.keys() if str(key).strip()]
    if len(quality_ids) != len(values):
        raise UserVisibleError(f"size_map.values contains an empty quality key in {path}")

    aspect_ids: List[str] = []
    aspect_seen: set[str] = set()
    request_values: Dict[str, Dict[str, Dict[str, str]]] = {}
    for quality_id in quality_ids:
        row = values.get(quality_id)
        if not isinstance(row, dict) or not row:
            raise UserVisibleError(f"size_map row '{quality_id}' must be a non-empty object in {path}")
        request_values[quality_id] = {}
        for aspect_id, cell in row.items():
            aspect_key = str(aspect_id or "").strip()
            if not aspect_key:
                raise UserVisibleError(f"size_map row '{quality_id}' contains an empty aspect key in {path}")
            parsed = _parse_ratio_value(aspect_key)
            if parsed is None:
                raise UserVisibleError(
                    f"size_map aspect key '{aspect_key}' in {path} must use N:M notation."
                )
            size = _parse_size_value(cell)
            if size is None:
                raise UserVisibleError(
                    f"size_map cell {quality_id}/{aspect_key} in {path} must use WIDTHxHEIGHT."
                )
            width, height = size
            request_values[quality_id][aspect_key] = {param: _normalized_size_text(width, height)}
            if aspect_key not in aspect_seen:
                aspect_seen.add(aspect_key)
                aspect_ids.append(aspect_key)

    aspect_control = {
        "label": {"ru": "Пропорции результата", "en": "Output aspect ratio"},
        "default": "selection",
        "options": _build_special_aspect_options() + [
            {"id": aspect_id, "label": aspect_id, "ratio": list(_parse_ratio_value(aspect_id) or (1, 1))}
            for aspect_id in aspect_ids
        ],
    }
    quality_control = {
        "label": {"ru": "Качество / разрешение", "en": "Quality / resolution"},
        "default": str(size_map.get("default") or quality_ids[0]),
        "options": [{"id": quality_id, "label": quality_id, "request": {}} for quality_id in quality_ids],
    }
    request_matrix = {"values": request_values}
    _validate_options(aspect_control, "aspect_ratio", path)
    _validate_options(quality_control, "quality", path)
    return aspect_control, quality_control, request_matrix


def _normalize_model(
    card: Dict[str, Any],
    path: Path,
    providers: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    provider_id = _required_string(card, "provider", path)
    remote_model = _required_string(card, "model", path)
    route_id = str(card.get("route") or "images_edit")
    provider = providers.get(provider_id)
    if provider is None:
        raise UserVisibleError(f"Unknown provider '{provider_id}' for {remote_model}: {path}")
    if route_id not in provider.get("routes", {}):
        raise UserVisibleError(f"Unknown route '{route_id}' for {remote_model}: {path}")

    controls: Dict[str, Any] = {}
    request_matrix = None

    size_map = card.get("size_map")
    if size_map is not None:
        aspect_control, quality_control, request_matrix = _normalize_size_map(size_map, path)
        controls["aspect_ratio"] = aspect_control
        controls["quality"] = quality_control
    else:
        aspect_data = card.get("aspect_ratio")
        if aspect_data is not None:
            if not isinstance(aspect_data, dict):
                raise UserVisibleError(f"aspect_ratio must be an object in {path}")
            param = _required_string(aspect_data, "param", path)
            values = _string_list(aspect_data.get("values"), "aspect_ratio.values", path)
            aspect_control = {
                "label": {"ru": "Пропорции результата", "en": "Output aspect ratio"},
                "default": str(aspect_data.get("default") or "selection"),
                "options": _build_aspect_options(values, param, path),
            }
            _validate_options(aspect_control, "aspect_ratio", path)
            controls["aspect_ratio"] = aspect_control

        quality_data = card.get("quality")
        if quality_data is not None:
            controls["quality"] = _normalize_quality_control(
                quality_data,
                path,
                {"ru": "Качество", "en": "Quality"},
            )

    fixed_request = card.get("request")
    if fixed_request is not None and not isinstance(fixed_request, dict):
        raise UserVisibleError(f"request must be an object in {path}")

    reference_supported = bool(card.get("reference"))
    reference_field = str(card.get("reference_field") or card.get("input_field") or "image")

    normalized = {
        "id": f"{provider_id}:{remote_model}",
        "provider": provider_id,
        "label": str(card.get("label") or remote_model),
        "remote_model": remote_model,
        "route": route_id,
        "capabilities": {
            "image_edit": True,
            "reference": {
                "supported": reference_supported,
                "maximum": 1,
                "multipart_field": reference_field,
                "provider_documented": bool(card.get("reference_documented", reference_supported)),
            },
        },
        "input": {"preferred_format": "jpeg", "formats": ["jpeg", "png", "webp"], "dimension_multiple": int(card.get("multiple") or 1), "multipart_field": str(card.get("input_field") or "image")},
        "controls": controls,
    }
    if fixed_request:
        normalized["request"] = fixed_request
    if request_matrix is not None:
        normalized["request_matrix"] = request_matrix
    return normalized


def _validate_model(
    card: Dict[str, Any],
    path: Path,
    providers: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    normalized = _normalize_model(card, path, providers)
    controls = normalized.get("controls") or {}
    for name in ("aspect_ratio", "quality"):
        control = controls.get(name)
        if control is not None:
            if not isinstance(control, dict):
                raise UserVisibleError(f"Control {name} must be an object: {path}")
            _validate_options(control, name, path)

    request_matrix = normalized.get("request_matrix")
    if request_matrix is not None:
        if not isinstance(request_matrix, dict) or not isinstance(request_matrix.get("values"), dict):
            raise UserVisibleError(f"request_matrix.values must be an object: {path}")
        aspect_control = controls.get("aspect_ratio") or {}
        quality_control = controls.get("quality") or {}
        aspect_ids = [
            str(option.get("id"))
            for option in aspect_control.get("options", [])
            if isinstance(option, dict) and isinstance(option.get("ratio"), list) and str(option.get("id")) not in ("auto", "selection")
        ]
        quality_ids = [
            str(option.get("id"))
            for option in quality_control.get("options", [])
            if isinstance(option, dict)
        ]
        values = request_matrix["values"]
        for quality_id in quality_ids:
            row = values.get(quality_id)
            if not isinstance(row, dict):
                raise UserVisibleError(
                    f"request_matrix has no row for quality '{quality_id}': {path}"
                )
            for aspect_id in aspect_ids:
                if not isinstance(row.get(aspect_id), dict):
                    raise UserVisibleError(
                        f"request_matrix has no cell for {quality_id}/{aspect_id}: {path}"
                    )
    return normalized

def load_catalog() -> CardCatalog:
    invalid: List[Dict[str, str]] = []
    providers: Dict[str, Dict[str, Any]] = {}
    models: Dict[str, Dict[str, Any]] = {}

    provider_dir = CARDS_DIR / "providers"
    model_dir = CARDS_DIR / "models"
    for path in sorted(provider_dir.rglob("*.json")) if provider_dir.is_dir() else []:
        try:
            card = _validate_provider(_read_json(path), path)
            provider_id = str(card["id"])
            if provider_id in providers:
                raise UserVisibleError(f"Duplicate provider ID '{provider_id}'")
            providers[provider_id] = card
        except Exception as exc:
            invalid.append({"file": str(path), "message": str(exc)})

    for path in sorted(model_dir.rglob("*.json")) if model_dir.is_dir() else []:
        try:
            card = _validate_model(_read_json(path), path, providers)
            model_id = str(card["id"])
            if model_id in models:
                raise UserVisibleError(f"Duplicate model ID '{model_id}'")
            models[model_id] = card
        except Exception as exc:
            invalid.append({"file": str(path), "message": str(exc)})

    if not providers:
        invalid.append({"file": str(provider_dir), "message": "No valid provider cards found."})
    if not models:
        invalid.append({"file": str(model_dir), "message": "No valid model cards found."})
    return CardCatalog(providers=providers, models=models, invalid_cards=invalid)


CATALOG_LOCK = threading.Lock()
CATALOG: Optional[CardCatalog] = None


def get_catalog(force: bool = False) -> CardCatalog:
    global CATALOG
    with CATALOG_LOCK:
        if CATALOG is None or force:
            CATALOG = load_catalog()
        return CATALOG


def find_option(control: Dict[str, Any], option_id: str) -> Dict[str, Any]:
    for option in control.get("options", []):
        if str(option.get("id")) == str(option_id):
            return option
    raise UserVisibleError(f"Unknown option '{option_id}'. Reopen the script window.")


def _nearest_aspect_option(control: Dict[str, Any], width: int, height: int) -> Dict[str, Any]:
    if width <= 0 or height <= 0:
        raise UserVisibleError("The input image dimensions are invalid.")
    target = width / float(height)
    candidates: List[Tuple[float, int, Dict[str, Any]]] = []
    index = 0
    for option in control.get("options", []):
        ratio = option.get("ratio")
        option_id = str(option.get("id") or "")
        if option_id in ("auto", "selection") or not isinstance(ratio, list) or len(ratio) != 2:
            index += 1
            continue
        try:
            current = float(ratio[0]) / float(ratio[1])
        except (TypeError, ValueError, ZeroDivisionError):
            index += 1
            continue
        score = abs(math.log(current / target))
        candidates.append((score, index, option))
        index += 1
    if not candidates:
        raise UserVisibleError("The model card has no usable aspect-ratio options.")
    candidates.sort(key=lambda item: (item[0], item[1]))
    return candidates[0][2]


def resolve_request_parameters(
    model: Dict[str, Any],
    aspect_ratio_id: str,
    quality_id: str,
    input_width: int,
    input_height: int,
) -> Tuple[Dict[str, Any], Dict[str, str]]:
    controls = model.get("controls") or {}
    request_params: Dict[str, Any] = {}
    fixed_request = model.get("request")
    if isinstance(fixed_request, dict):
        request_params.update(fixed_request)
    resolved_ids: Dict[str, str] = {}

    aspect_control = controls.get("aspect_ratio")
    if isinstance(aspect_control, dict):
        selected = find_option(
            aspect_control,
            aspect_ratio_id or str(aspect_control.get("default") or ""),
        )
        if selected.get("auto_nearest"):
            selected = _nearest_aspect_option(aspect_control, input_width, input_height)
        if not selected.get("selection_keep"):
            request = selected.get("request")
            if isinstance(request, dict):
                request_params.update(request)
        resolved_ids["aspect_ratio"] = str(selected.get("id") or "")

    quality_control = controls.get("quality")
    if isinstance(quality_control, dict):
        selected = find_option(
            quality_control,
            quality_id or str(quality_control.get("default") or ""),
        )
        request = selected.get("request")
        if isinstance(request, dict):
            request_params.update(request)
        resolved_ids["quality"] = str(selected.get("id") or "")

    # Some providers expose one generic `size=WIDTHxHEIGHT` field while the
    # model UI is more naturally represented as independent aspect-ratio and
    # resolution/quality selectors. A bundled card may therefore define a
    # validated matrix whose cell is merged after both option IDs are resolved.
    request_matrix = model.get("request_matrix")
    if isinstance(request_matrix, dict):
        values = request_matrix.get("values")
        quality_key = resolved_ids.get("quality", "")
        aspect_key = resolved_ids.get("aspect_ratio", "")
        row = values.get(quality_key) if isinstance(values, dict) else None
        cell = row.get(aspect_key) if isinstance(row, dict) else None
        if aspect_key != "selection":
            if not isinstance(cell, dict):
                raise UserVisibleError(
                    "The selected aspect ratio and quality are not compatible in the model card."
                )
            request_params.update(cell)

    return request_params, resolved_ids


# ---------------------------------------------------------------------------
# Remote adapters
# ---------------------------------------------------------------------------


@dataclass
class GenerationJob:
    request_id: str
    provider: Dict[str, Any]
    model: Dict[str, Any]
    route: Dict[str, Any]
    api_key: str
    prompt: str
    input_path: Path
    reference_path: Optional[Path]
    input_width: int
    input_height: int
    aspect_ratio_id: str
    quality_id: str
    timeout: int


@dataclass
class AdapterResult:
    image_bytes: bytes
    mime_type: Optional[str] = None
    remote_request_id: str = ""
    warnings: List[str] = field(default_factory=list)
    response_metadata: Dict[str, Any] = field(default_factory=dict)


class BaseAdapter:
    adapter_id = ""

    def execute(self, job: GenerationJob, cancel_event: threading.Event) -> AdapterResult:
        raise NotImplementedError


class OpenAIImagesEditAdapter(BaseAdapter):
    adapter_id = "openai_images_edit"

    def execute(self, job: GenerationJob, cancel_event: threading.Event) -> AdapterResult:
        if cancel_event.is_set():
            raise CancelledError("Generation was cancelled.")

        base_url = str(job.provider.get("base_url") or "").rstrip("/")
        path = str(job.route.get("path") or "")
        url = base_url + (path if path.startswith("/") else "/" + path)
        request_params, resolved_ids = resolve_request_parameters(
            job.model,
            job.aspect_ratio_id,
            job.quality_id,
            job.input_width,
            job.input_height,
        )
        form: Dict[str, Any] = {
            "model": str(job.model.get("remote_model")),
            "prompt": job.prompt,
        }
        route_defaults = job.route.get("request_defaults")
        if isinstance(route_defaults, dict):
            for key, value in route_defaults.items():
                if str(key) not in {"model", "prompt"} and value is not None and value != "":
                    form[str(key)] = str(value)
        for key, value in request_params.items():
            if value is not None and value != "":
                form[str(key)] = str(value)

        reference_capability = (
            job.model.get("capabilities", {}).get("reference", {})
            if isinstance(job.model.get("capabilities"), dict)
            else {}
        )
        if job.reference_path and not bool(reference_capability.get("supported")):
            raise UserVisibleError("The selected model does not support a reference image.")

        headers = {
            "Authorization": f"Bearer {job.api_key}",
            "Accept": "application/json",
        }
        with ExitStack() as stack:
            source_stream = stack.enter_context(job.input_path.open("rb"))
            input_capability = job.model.get("input", {}) if isinstance(job.model.get("input"), dict) else {}
            input_field = str(input_capability.get("multipart_field") or "image")
            files: List[Tuple[str, Tuple[str, Any, str]]] = [
                (
                    input_field,
                    (
                        job.input_path.name,
                        source_stream,
                        mimetypes.guess_type(job.input_path.name)[0]
                        or "application/octet-stream",
                    ),
                )
            ]
            warnings: List[str] = []
            if job.reference_path:
                reference_stream = stack.enter_context(job.reference_path.open("rb"))
                reference_field = str(
                    reference_capability.get("multipart_field") or "image"
                )
                files.append(
                    (
                        reference_field,
                        (
                            job.reference_path.name,
                            reference_stream,
                            mimetypes.guess_type(job.reference_path.name)[0]
                            or "application/octet-stream",
                        ),
                    )
                )
                if not bool(reference_capability.get("provider_documented")):
                    provider_label = str(
                        job.provider.get("label") or job.provider.get("id") or "The provider"
                    )
                    warnings.append(
                        "The reference image was sent as an additional multipart image, "
                        f"but {provider_label} does not currently document this form explicitly."
                    )

            LOGGER.info(
                "Remote image edit: provider=%s model=%s route=%s size=%s quality=%s reference=%s",
                job.provider.get("id"),
                job.model.get("id"),
                job.model.get("route"),
                form.get("size", "auto"),
                form.get("quality", "auto"),
                bool(job.reference_path),
            )
            try:
                response = REQUESTS.post(
                    url,
                    headers=headers,
                    data=form,
                    files=files,
                    timeout=job.timeout,
                )
            except REQUESTS.Timeout as exc:
                raise UserVisibleError(
                    f"The remote API request timed out after {job.timeout} seconds."
                ) from exc
            except REQUESTS.RequestException as exc:
                raise UserVisibleError(f"Could not connect to the remote API: {exc}") from exc

        if not response.ok:
            details = format_http_error_body(response.text)
            suffix = f"\n\n{details}" if details else ""
            raise UserVisibleError(
                f"{job.provider.get('label', job.provider.get('id'))} returned "
                f"HTTP {response.status_code}.{suffix}"
            )
        try:
            payload = response.json()
        except ValueError as exc:
            raise UserVisibleError("The remote API returned invalid JSON.") from exc
        if not isinstance(payload, dict):
            raise UserVisibleError("The remote API returned an unexpected response.")
        items = payload.get("data")
        if not isinstance(items, list) or not items or not isinstance(items[0], dict):
            raise UserVisibleError("The remote API response does not contain data[0].")
        item = items[0]
        image_bytes: bytes
        mime_type: Optional[str] = None
        response_config = job.route.get("response")
        if not isinstance(response_config, dict):
            response_config = {}
        base64_fields = response_config.get("base64_fields")
        if not isinstance(base64_fields, list) or not base64_fields:
            base64_fields = ["b64_json", "b64Json"]
        url_fields = response_config.get("url_fields")
        if not isinstance(url_fields, list) or not url_fields:
            url_fields = ["url"]

        encoded_image = ""
        for field_name in base64_fields:
            value = item.get(str(field_name))
            if value:
                encoded_image = str(value).strip()
                break
        result_url = ""
        for field_name in url_fields:
            value = item.get(str(field_name))
            if value:
                result_url = str(value).strip()
                break

        if encoded_image:
            if encoded_image.startswith("data:") and "," in encoded_image:
                encoded_image = encoded_image.split(",", 1)[1]
            try:
                image_bytes = base64.b64decode(encoded_image, validate=True)
            except Exception as exc:
                raise UserVisibleError("The returned base64 image is damaged.") from exc
        elif result_url:
            try:
                download = REQUESTS.get(result_url, timeout=job.timeout)
                download.raise_for_status()
            except REQUESTS.RequestException as exc:
                raise UserVisibleError(f"Could not download the generated image: {exc}") from exc
            image_bytes = download.content
            mime_type = download.headers.get("Content-Type")
        else:
            expected = ", ".join([str(value) for value in base64_fields + url_fields])
            raise UserVisibleError(
                "The remote API response does not contain a generated image "
                f"({expected})."
            )

        remote_request_id = str(
            response.headers.get("x-request-id")
            or response.headers.get("x-requestid")
            or payload.get("id")
            or ""
        )
        return AdapterResult(
            image_bytes=image_bytes,
            mime_type=mime_type,
            remote_request_id=remote_request_id,
            warnings=warnings,
            response_metadata={"resolved_options": resolved_ids},
        )



class GenAPIAsyncAdapter(BaseAdapter):
    adapter_id = "genapi_async"

    @staticmethod
    def _form_value(value: Any) -> str:
        if isinstance(value, bool):
            return "true" if value else "false"
        if value is None:
            return ""
        if isinstance(value, (dict, list)):
            return json.dumps(value, ensure_ascii=False)
        return str(value)

    @staticmethod
    def _safe_json_response(response: Any) -> Dict[str, Any]:
        try:
            payload = response.json()
        except ValueError as exc:
            raise UserVisibleError("The remote API returned invalid JSON.") from exc
        if not isinstance(payload, dict):
            raise UserVisibleError("The remote API returned an unexpected response.")
        return payload

    @staticmethod
    def _status_text(payload: Dict[str, Any]) -> str:
        return str(payload.get("status") or "").strip().lower()

    @staticmethod
    def _extract_request_id(payload: Dict[str, Any]) -> str:
        value = payload.get("request_id")
        if value in (None, ""):
            value = payload.get("id")
        return str(value) if value not in (None, "") else ""

    @staticmethod
    def _extract_result_urls(payload: Dict[str, Any]) -> List[str]:
        urls: List[str] = []
        result = payload.get("result")
        if isinstance(result, list):
            for item in result:
                if isinstance(item, str) and item.strip():
                    urls.append(item.strip())
                elif isinstance(item, dict):
                    value = item.get("url")
                    if isinstance(value, str) and value.strip():
                        urls.append(value.strip())
        full_response = payload.get("full_response")
        if isinstance(full_response, list):
            for item in full_response:
                if isinstance(item, dict):
                    for key in ("url", "image_url", "output_url"):
                        value = item.get(key)
                        if isinstance(value, str) and value.strip():
                            urls.append(value.strip())
                            break
        output = payload.get("output")
        if isinstance(output, str) and output.strip():
            urls.append(output.strip())
        elif isinstance(output, list):
            for item in output:
                if isinstance(item, str) and item.strip():
                    urls.append(item.strip())
                elif isinstance(item, dict):
                    value = item.get("url")
                    if isinstance(value, str) and value.strip():
                        urls.append(value.strip())
        seen: set[str] = set()
        unique: List[str] = []
        for url in urls:
            if url not in seen:
                seen.add(url)
                unique.append(url)
        return unique

    def execute(self, job: GenerationJob, cancel_event: threading.Event) -> AdapterResult:
        if cancel_event.is_set():
            raise CancelledError("Generation was cancelled.")

        base_url = str(job.provider.get("base_url") or "").rstrip("/")
        create_path = str(job.route.get("path") or "")
        result_path = str(job.route.get("result_path") or "")
        if not create_path or not result_path:
            raise UserVisibleError("The GenAPI provider card is missing path settings.")
        create_url = base_url + (create_path if create_path.startswith("/") else "/" + create_path)
        create_url = create_url.replace("{network_id}", urllib.parse.quote(str(job.model.get("remote_model") or ""), safe=""))

        request_params, resolved_ids = resolve_request_parameters(
            job.model,
            job.aspect_ratio_id,
            job.quality_id,
            job.input_width,
            job.input_height,
        )
        form: Dict[str, Any] = {"prompt": job.prompt}
        route_defaults = job.route.get("request_defaults")
        if isinstance(route_defaults, dict):
            for key, value in route_defaults.items():
                if str(key) not in {"prompt"} and value is not None and value != "":
                    form[str(key)] = value
        for key, value in request_params.items():
            if value is not None and value != "":
                form[str(key)] = value

        reference_capability = (
            job.model.get("capabilities", {}).get("reference", {})
            if isinstance(job.model.get("capabilities"), dict)
            else {}
        )
        if job.reference_path and not bool(reference_capability.get("supported")):
            raise UserVisibleError("The selected model does not support a reference image.")

        headers = {
            "Authorization": f"Bearer {job.api_key}",
            "Accept": "application/json",
        }
        warnings: List[str] = []
        multipart_field = str(job.route.get("multipart_image_field") or "image_urls[]")
        with ExitStack() as stack:
            source_stream = stack.enter_context(job.input_path.open("rb"))
            files: List[Tuple[str, Tuple[str, Any, str]]] = [
                (
                    multipart_field,
                    (
                        job.input_path.name,
                        source_stream,
                        mimetypes.guess_type(job.input_path.name)[0] or "application/octet-stream",
                    ),
                )
            ]
            if job.reference_path:
                reference_stream = stack.enter_context(job.reference_path.open("rb"))
                reference_field = str(reference_capability.get("multipart_field") or multipart_field)
                files.append(
                    (
                        reference_field,
                        (
                            job.reference_path.name,
                            reference_stream,
                            mimetypes.guess_type(job.reference_path.name)[0] or "application/octet-stream",
                        ),
                    )
                )
                if not bool(reference_capability.get("provider_documented")):
                    provider_label = str(job.provider.get("label") or job.provider.get("id") or "The provider")
                    warnings.append(
                        "The reference image was sent as an additional multipart image, "
                        f"but {provider_label} does not currently document this form explicitly."
                    )
            try:
                response = REQUESTS.post(
                    create_url,
                    headers=headers,
                    data={key: self._form_value(value) for key, value in form.items()},
                    files=files,
                    timeout=job.timeout,
                )
            except REQUESTS.Timeout as exc:
                raise UserVisibleError(
                    f"The remote API request timed out after {job.timeout} seconds."
                ) from exc
            except REQUESTS.RequestException as exc:
                raise UserVisibleError(f"Could not connect to the remote API: {exc}") from exc

        if not response.ok:
            details = format_http_error_body(response.text)
            suffix = f"\n\n{details}" if details else ""
            raise UserVisibleError(
                f"{job.provider.get('label', job.provider.get('id'))} returned "
                f"HTTP {response.status_code}.{suffix}"
            )
        create_payload = self._safe_json_response(response)
        state = self._status_text(create_payload)
        remote_request_id = self._extract_request_id(create_payload)
        final_payload = create_payload
        start_time = time.monotonic()
        poll_interval = float(job.route.get("poll_interval_seconds") or 3.0)
        if state not in {"success", "completed", "done"}:
            if not remote_request_id:
                raise UserVisibleError("The remote API response contains no request ID.")
            result_url = base_url + (result_path if result_path.startswith("/") else "/" + result_path)
            while True:
                if cancel_event.is_set():
                    raise CancelledError("Generation was cancelled.")
                if time.monotonic() - start_time > float(job.timeout):
                    raise UserVisibleError(
                        f"The remote API request timed out after {job.timeout} seconds."
                    )
                try:
                    poll = REQUESTS.get(
                        result_url.replace("{request_id}", urllib.parse.quote(remote_request_id, safe="")),
                        headers=headers,
                        timeout=min(job.timeout, 60),
                    )
                except REQUESTS.Timeout as exc:
                    raise UserVisibleError(
                        f"The remote API request timed out after {job.timeout} seconds."
                    ) from exc
                except REQUESTS.RequestException as exc:
                    raise UserVisibleError(f"Could not connect to the remote API: {exc}") from exc
                if not poll.ok:
                    details = format_http_error_body(poll.text)
                    suffix = f"\n\n{details}" if details else ""
                    raise UserVisibleError(
                        f"{job.provider.get('label', job.provider.get('id'))} returned "
                        f"HTTP {poll.status_code}.{suffix}"
                    )
                final_payload = self._safe_json_response(poll)
                state = self._status_text(final_payload)
                if state in {"success", "completed", "done"}:
                    break
                if state in {"error", "failed", "cancelled", "canceled"}:
                    details = (
                        final_payload.get("error")
                        or final_payload.get("message")
                        or final_payload.get("detail")
                        or final_payload
                    )
                    raise UserVisibleError(f"The remote API request failed.\n\n{details}")
                time.sleep(max(1.0, poll_interval))

        urls = self._extract_result_urls(final_payload)
        if not urls:
            raise UserVisibleError("The remote API response does not contain a generated image URL.")
        last_error: Optional[str] = None
        image_bytes: Optional[bytes] = None
        mime_type: Optional[str] = None
        for url in urls:
            try:
                download = REQUESTS.get(url, timeout=job.timeout)
                download.raise_for_status()
                if not download.content:
                    raise UserVisibleError("The downloaded generated image is empty.")
                image_bytes = download.content
                mime_type = download.headers.get("Content-Type")
                break
            except REQUESTS.RequestException as exc:
                last_error = str(exc)
        if image_bytes is None:
            raise UserVisibleError(
                "Could not download the generated image." + (f"\n\n{last_error}" if last_error else "")
            )
        metadata = {
            "resolved_options": resolved_ids,
            "cost": final_payload.get("cost"),
            "runtime": final_payload.get("runtime"),
            "response_type": final_payload.get("response_type"),
        }
        return AdapterResult(
            image_bytes=image_bytes,
            mime_type=mime_type,
            remote_request_id=remote_request_id,
            warnings=warnings,
            response_metadata=metadata,
        )


ADAPTERS = {
    OpenAIImagesEditAdapter.adapter_id: OpenAIImagesEditAdapter,
    GenAPIAsyncAdapter.adapter_id: GenAPIAsyncAdapter,
}


def normalize_result_image(image_bytes: bytes, destination: Path) -> Tuple[Path, int, int]:
    try:
        with PIL_IMAGE.open(io.BytesIO(image_bytes)) as image:
            image.load()
            width, height = int(image.width), int(image.height)
            if width <= 0 or height <= 0:
                raise ValueError("empty image")
            if image.mode not in {"RGB", "RGBA", "L", "LA"}:
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            destination.parent.mkdir(parents=True, exist_ok=True)
            image.save(destination, format="PNG", optimize=False)
    except Exception as exc:
        raise UserVisibleError("The API returned data that is not a readable image.") from exc
    return destination, width, height


# ---------------------------------------------------------------------------
# Local socket protocol and generation lifecycle
# ---------------------------------------------------------------------------


@dataclass
class GenerationState:
    request_id: Optional[str] = None
    provider_id: str = ""
    model_id: str = ""
    cancel_event: threading.Event = field(default_factory=threading.Event)
    ack_event: threading.Event = field(default_factory=threading.Event)
    active: bool = False
    queued: bool = False


GENERATION = GenerationState()
GENERATION_QUEUE: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=1)
GENERATION_SUBMIT_LOCK = threading.Lock()
WORKER_STOP = threading.Event()
LAST_ACTIVITY = time.monotonic()
LAST_ACTIVITY_LOCK = threading.Lock()
REPLY_LOCK = threading.Lock()


def touch_activity() -> None:
    global LAST_ACTIVITY
    with LAST_ACTIVITY_LOCK:
        LAST_ACTIVITY = time.monotonic()


@contextmanager
def generation_context(task: Dict[str, Any]):
    request_id = str(task.get("request_id") or uuid.uuid4())
    task["request_id"] = request_id
    GENERATION.request_id = request_id
    GENERATION.provider_id = ""
    GENERATION.model_id = ""
    GENERATION.cancel_event.clear()
    GENERATION.ack_event.clear()
    GENERATION.active = True
    GENERATION.queued = False
    try:
        raise_if_generation_cancelled(request_id)
        yield request_id
    finally:
        GENERATION.request_id = None
        GENERATION.provider_id = ""
        GENERATION.model_id = ""
        GENERATION.active = False
        GENERATION.queued = False
        GENERATION.cancel_event.clear()
        GENERATION.ack_event.clear()
        touch_activity()


def send_data_to_jsx(message: Dict[str, Any], retries: int = 20) -> bool:
    try:
        payload = (api_json_dumps(message) + "\n").encode("ascii")
    except Exception:
        log_exception("Could not serialize the JSX response")
        return False
    LOGGER.info(
        "JSX response: type=%s request=%s bytes=%s",
        message.get("type"),
        message.get("request_id"),
        len(payload),
    )
    with REPLY_LOCK:
        for attempt in range(retries):
            try:
                with socket.create_connection((API_HOST, API_REPLY_PORT), timeout=2.0) as sock:
                    sock.settimeout(10.0)
                    sock.sendall(payload)
                return True
            except OSError as exc:
                if attempt + 1 < retries:
                    time.sleep(0.05)
                else:
                    LOGGER.error("Could not send JSX response: %s", exc)
    return False


def answer(message: Any, request_id: Optional[str] = None) -> None:
    send_data_to_jsx(
        {
            "protocol": API_PROTOCOL,
            "request_id": request_id,
            "type": "answer",
            "message": message,
        }
    )


def error_answer(message: str, request_id: Optional[str] = None) -> None:
    send_data_to_jsx(
        {
            "protocol": API_PROTOCOL,
            "request_id": request_id,
            "type": "error",
            "message": str(message),
        }
    )


def cancelled_answer(request_id: Optional[str] = None) -> None:
    send_data_to_jsx(
        {
            "protocol": API_PROTOCOL,
            "request_id": request_id,
            "type": "cancelled",
            "message": "Generation was cancelled.",
        }
    )


def notify_generation_progress_ready(request_id: str, model_label: str) -> None:
    raise_if_generation_cancelled(request_id)
    GENERATION.ack_event.clear()
    payload = {
        "protocol": API_PROTOCOL,
        "request_id": request_id,
        "type": "answer",
        "message": "init",
        "backend": "api",
        "model": model_label,
    }
    if not send_data_to_jsx(payload):
        raise UserVisibleError(
            "Could not switch Photoshop to the remote-generation stage."
        )
    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline:
        if GENERATION.ack_event.wait(timeout=0.1):
            return
        raise_if_generation_cancelled(request_id)
    LOGGER.warning("Progress ACK timeout: request=%s; continuing", request_id)


def request_is_cancelled(request_id: str) -> bool:
    return bool(GENERATION.request_id == request_id and GENERATION.cancel_event.is_set())


def raise_if_generation_cancelled(request_id: str) -> None:
    if request_is_cancelled(request_id):
        raise CancelledError("Generation was cancelled.")


def cancel_current_generation(request_id: Optional[str] = None) -> None:
    current = GENERATION.request_id
    requested = str(request_id or "")
    if current and (not requested or requested == current):
        GENERATION.cancel_event.set()
        LOGGER.info("Cancellation requested: %s", current)


def _path_from_message(value: Any, label: str, required: bool = True) -> Optional[Path]:
    text = str(value or "").strip()
    if not text:
        if required:
            raise UserVisibleError(f"{label} was not provided.")
        return None
    path = Path(text)
    if not path.is_file():
        raise UserVisibleError(f"{label} was not found: {path}")
    return path


def _run_api_generation(task: Dict[str, Any], request_id: str) -> None:
    message = task.get("message") if isinstance(task.get("message"), dict) else {}
    catalog = get_catalog(force=False)
    provider_id = str(message.get("provider_id") or "")
    model_id = str(message.get("model_id") or "")
    provider = catalog.providers.get(provider_id)
    model = catalog.models.get(model_id)
    if provider is None:
        raise UserVisibleError("The selected provider is missing from the bundled cards.")
    if model is None or str(model.get("provider")) != provider_id:
        raise UserVisibleError("The selected model is missing from the bundled cards.")
    route_id = str(model.get("route") or "")
    route = provider.get("routes", {}).get(route_id)
    if not isinstance(route, dict):
        raise UserVisibleError("The model route is missing from the provider card.")
    adapter_id = str(route.get("adapter") or "")
    adapter_class = ADAPTERS.get(adapter_id)
    if adapter_class is None:
        raise UserVisibleError(f"Unsupported adapter: {adapter_id}")

    prompt = str(message.get("prompt") or "").strip()
    if not prompt:
        raise UserVisibleError("Prompt is empty.")
    input_path = _path_from_message(message.get("input"), "Photoshop input image")
    reference_path = _path_from_message(
        message.get("reference"), "Reference image", required=False
    )
    encrypted_credential = str(message.get("credential") or "")
    if not encrypted_credential:
        raise UserVisibleError(
            f"API key is not configured for {provider.get('label', provider_id)}."
        )
    api_key = dpapi_decrypt(encrypted_credential, entropy=f"{APP_NAME}:{provider_id}")
    if not api_key.strip():
        raise UserVisibleError("The stored API key is empty.")

    try:
        input_width = int(message.get("input_width") or 0)
        input_height = int(message.get("input_height") or 0)
        timeout = max(30, int(message.get("timeout") or 1200))
    except (TypeError, ValueError) as exc:
        raise UserVisibleError("Invalid image dimensions or timeout.") from exc

    GENERATION.provider_id = provider_id
    GENERATION.model_id = model_id
    job = GenerationJob(
        request_id=request_id,
        provider=provider,
        model=model,
        route=route,
        api_key=api_key,
        prompt=prompt,
        input_path=input_path,
        reference_path=reference_path,
        input_width=input_width,
        input_height=input_height,
        aspect_ratio_id=str(message.get("aspect_ratio_id") or ""),
        quality_id=str(message.get("quality_id") or ""),
        timeout=timeout,
    )

    notify_generation_progress_ready(request_id, str(model.get("label") or model_id))
    adapter = adapter_class()
    try:
        result = adapter.execute(job, GENERATION.cancel_event)
    finally:
        job.api_key = ""
        api_key = ""
    raise_if_generation_cancelled(request_id)

    destination = TEMP_DIR / (
        time.strftime("%Y%m%d-%H%M%S")
        + "-"
        + safe_filename(str(model.get("remote_model") or model_id))
        + "-"
        + request_id[-8:]
        + ".png"
    )
    path, width, height = normalize_result_image(result.image_bytes, destination)
    raise_if_generation_cancelled(request_id)
    answer(
        {
            "path": str(path),
            "provider_id": provider_id,
            "model_id": model_id,
            "remote_request_id": result.remote_request_id,
            "actual_width": width,
            "actual_height": height,
            "mime_type": "image/png",
            "warnings": result.warnings,
            "response_metadata": result.response_metadata,
        },
        request_id=request_id,
    )


def generation_worker() -> None:
    while not WORKER_STOP.is_set():
        try:
            task = GENERATION_QUEUE.get(timeout=0.5)
        except queue.Empty:
            continue
        try:
            with generation_context(task) as request_id:
                _run_api_generation(task, request_id)
        except CancelledError:
            cancelled_answer(task.get("request_id"))
        except UserVisibleError as exc:
            LOGGER.warning("Generation error: %s", exc)
            error_answer(str(exc), task.get("request_id"))
        except Exception as exc:
            log_exception("Unhandled generation error")
            error_answer(f"Internal Python error: {exc}", task.get("request_id"))
        finally:
            GENERATION_QUEUE.task_done()


def apply_handshake(message: Dict[str, Any]) -> Dict[str, Any]:
    catalog = get_catalog(force=bool(message.get("reload_cards")))
    runtime_data = {
        "cards_dir": str(CARDS_DIR),
        "generation_timeout": int(message.get("generationTimeout") or 1200),
        "updated": time.time(),
    }
    try:
        RUNTIME_FILE.write_text(
            json.dumps(runtime_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError:
        LOGGER.warning("Could not write runtime.json")
    return {
        "ok": True,
        "app_dir": str(APP_DIR),
        "log_file": str(LOG_FILE),
        "cards_dir": str(CARDS_DIR),
        "version": VERSION,
        "protocol": API_PROTOCOL,
        "catalog": catalog.public_dict(),
    }


def handle_command(command: Dict[str, Any]) -> None:
    touch_activity()
    request_id = command.get("request_id")
    command_type = str(command.get("type") or "")
    message = command.get("message")
    if not isinstance(message, dict):
        message = {} if message in (None, "") else {"value": message}
    LOGGER.info("API command: type=%s request=%s", command_type, request_id)
    try:
        protocol = command.get("protocol")
        if protocol is not None and str(protocol) != str(API_PROTOCOL):
            raise UserVisibleError(
                f"Incompatible API protocol version: {protocol}; expected {API_PROTOCOL}."
            )
        if command_type == "ping":
            answer({"ok": True, "version": VERSION, "protocol": API_PROTOCOL}, request_id)
            return
        if command_type == "handshake":
            answer(apply_handshake(message), request_id)
            return
        if command_type == "credential_encrypt":
            provider_id = str(message.get("provider_id") or "").strip()
            secret = str(message.get("secret") or "")
            if not provider_id or provider_id not in get_catalog().providers:
                raise UserVisibleError("Unknown provider for API-key storage.")
            if not secret.strip():
                raise UserVisibleError("API key is empty.")
            encrypted = dpapi_encrypt(secret, entropy=f"{APP_NAME}:{provider_id}")
            secret = ""
            answer({"encrypted": encrypted}, request_id)
            return
        if command_type == "translate":
            text = str(message.get("text") or message.get("value") or "").strip()
            if not text:
                answer("", request_id)
                return
            try:
                translated = get_translation_module().GoogleTranslator(
                    source="auto", target="english"
                ).translate(text)
            except Exception as exc:
                LOGGER.exception("Prompt translation error")
                raise UserVisibleError(f"Could not translate prompt: {exc}") from exc
            answer(str(translated or ""), request_id)
            return
        if command_type == "api_generate":
            with GENERATION_SUBMIT_LOCK:
                if GENERATION.active or GENERATION.queued or not GENERATION_QUEUE.empty():
                    raise UserVisibleError("The previous generation has not finished yet.")
                GENERATION.queued = True
                GENERATION_QUEUE.put(command)
            return
        if command_type == "ack":
            ack_request_id = str(request_id or message.get("request_id") or "")
            if not GENERATION.request_id or not ack_request_id or ack_request_id == GENERATION.request_id:
                GENERATION.ack_event.set()
            return
        if command_type == "interrupt":
            cancel_current_generation(str(message.get("request_id") or request_id or ""))
            return
        raise UserVisibleError(f"Unknown API command: {command_type}")
    except UserVisibleError as exc:
        error_answer(str(exc), request_id)
    except Exception as exc:
        log_exception(f"Command error: {command_type}")
        error_answer(f"Internal Python error: {exc}", request_id)


def receive_json_message(client_socket: socket.socket) -> Dict[str, Any]:
    chunks: List[bytes] = []
    total = 0
    client_socket.settimeout(5.0)
    while True:
        chunk = client_socket.recv(65536)
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > MAX_API_MESSAGE:
            raise UserVisibleError("The local API message is too large.")
        if b"\n" in chunk:
            break
    raw = b"".join(chunks).split(b"\n", 1)[0]
    if not raw:
        raise UserVisibleError("The local API received an empty command.")
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise UserVisibleError(f"The local API received invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise UserVisibleError("The local API command must be a JSON object.")
    return value


def handle_client(client_socket: socket.socket) -> None:
    try:
        command = receive_json_message(client_socket)
        handle_command(command)
    except UserVisibleError as exc:
        # JSX checks whether the server is running by opening and immediately
        # closing the port. That empty connection is a health probe, not an error.
        if str(exc) != "The local API received an empty command.":
            LOGGER.warning("Local client error: %s", exc)
    except Exception:
        log_exception("Local client handler error")
    finally:
        try:
            client_socket.close()
        except OSError:
            pass


def write_lock_file() -> None:
    data = {
        "pid": os.getpid(),
        "host": API_HOST,
        "receive_port": API_RECEIVE_PORT,
        "reply_port": API_REPLY_PORT,
        "version": VERSION,
        "protocol": API_PROTOCOL,
        "started": time.time(),
    }
    try:
        LOCK_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        LOGGER.warning("Could not write lock file")


def remove_lock_file() -> None:
    try:
        LOCK_FILE.unlink(missing_ok=True)
    except OSError:
        pass


def idle_watcher() -> None:
    while not WORKER_STOP.wait(timeout=5.0):
        with LAST_ACTIVITY_LOCK:
            idle = time.monotonic() - LAST_ACTIVITY
        if idle >= IDLE_TIMEOUT_SECONDS and not GENERATION.active and GENERATION_QUEUE.empty():
            LOGGER.info("Idle timeout reached; stopping local server")
            WORKER_STOP.set()
            try:
                with socket.create_connection((API_HOST, API_RECEIVE_PORT), timeout=0.5):
                    pass
            except OSError:
                pass
            return


def start_local_server() -> None:
    cleanup_old_temp_files()
    prepare_required_modules()
    get_catalog(force=True)
    write_lock_file()
    atexit.register(remove_lock_file)

    worker = threading.Thread(target=generation_worker, name="GenerationWorker", daemon=True)
    worker.start()
    watcher = threading.Thread(target=idle_watcher, name="IdleWatcher", daemon=True)
    watcher.start()

    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server.bind((API_HOST, API_RECEIVE_PORT))
        server.listen(8)
        server.settimeout(1.0)
        LOGGER.info(
            "%s %s listening on %s:%s",
            APP_NAME,
            VERSION,
            API_HOST,
            API_RECEIVE_PORT,
        )
        while not WORKER_STOP.is_set():
            try:
                client, _address = server.accept()
            except socket.timeout:
                continue
            except OSError:
                if WORKER_STOP.is_set():
                    break
                raise
            threading.Thread(
                target=handle_client,
                args=(client,),
                name="LocalClient",
                daemon=True,
            ).start()
    finally:
        WORKER_STOP.set()
        try:
            server.close()
        except OSError:
            pass
        remove_lock_file()


if __name__ == "__main__":
    try:
        start_local_server()
    except Exception:
        log_exception("Fatal API server error")
        raise
