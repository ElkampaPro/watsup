import os
import json
import urllib.request
import urllib.error

def load_ipc_token(token_path):
    """
    Loads and returns the IPC token from the specified path.
    Returns None if the file does not exist or if an error occurs.
    """
    if os.path.exists(token_path):
        try:
            with open(token_path, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception:
            return None
    return None

def make_api_request(
    path,
    data=None,
    timeout=8,
    ipc_token=None,
    base_url="http://127.0.0.1:5001",
    opener=None
):
    """
    Performs a native HTTP request to the local Express backend API.
    """
    url = f"{base_url}{path}"
    try:
        req_data = json.dumps(data).encode('utf-8') if data else None
        headers = {'Content-Type': 'application/json'} if data else {}
        if ipc_token:
            headers['X-WatsUp-Token'] = ipc_token

        req = urllib.request.Request(
            url,
            data=req_data,
            headers=headers
        )

        open_fn = opener.open if opener else urllib.request.urlopen
        with open_fn(req, timeout=timeout) as response:
            return json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode('utf-8')
            result = json.loads(err_body)
            if isinstance(result, dict):
                result["status_code"] = e.code
            return result
        except Exception:
            return {
                "success": False,
                "status_code": e.code,
                "error": f"HTTP Error {e.code}: {e.reason}"
            }
        finally:
            e.close()
    except urllib.error.URLError as e:
        return {
            "offline_flag": True,
            "error": str(getattr(e, 'reason', e))
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e)
        }
