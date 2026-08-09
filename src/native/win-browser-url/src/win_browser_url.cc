#include <napi.h>
#include <windows.h>
#include <uiautomation.h>
#include <combaseapi.h>
#include <string>

/**
 * Windows-only native helper that reads the active browser tab URL from a
 * window handle (HWND) using the UI Automation (UIA) API.
 *
 * The caller passes the HWND obtained from active-win. We locate the browser's
 * address-bar edit control and return its value. This works for Chromium-based
 * browsers (Chrome, Edge, Brave) and Firefox on Windows.
 */

static std::string BstrToUtf8(BSTR bstr) {
  if (!bstr) {
    return {};
  }
  int len = SysStringLen(bstr);
  if (len <= 0) {
    return {};
  }
  int utf8Len = WideCharToMultiByte(CP_UTF8, 0, bstr, len, nullptr, 0, nullptr, nullptr);
  if (utf8Len <= 0) {
    return {};
  }
  std::string out;
  out.resize(utf8Len);
  WideCharToMultiByte(CP_UTF8, 0, bstr, len, &out[0], utf8Len, nullptr, nullptr);
  return out;
}

static bool LooksLikeUrl(const std::string& value) {
  if (value.empty()) {
    return false;
  }
  // Reject values that look like free-form text rather than a URL.
  if (value.find('\n') != std::string::npos || value.find('\r') != std::string::npos) {
    return false;
  }
  size_t spaces = 0;
  for (char c : value) {
    if (c == ' ') {
      ++spaces;
    }
  }
  if (spaces > 5) {
    return false;
  }
  if (value.find("://") != std::string::npos) {
    return true;
  }
  if (value.find('.') == std::string::npos) {
    return false;
  }
  return true;
}

static std::string NormalizeUrl(const std::string& value) {
  if (value.find("://") != std::string::npos) {
    return value;
  }
  return "https://" + value;
}

class ComInit {
 public:
  ComInit() : needs_uninit_(false) {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (hr == S_OK) {
      needs_uninit_ = true;
    }
    // RPC_E_CHANGED_MODE means COM is already initialized on this thread;
    // we can still use it, just don't uninitialize it here.
  }
  ~ComInit() {
    if (needs_uninit_) {
      CoUninitialize();
    }
  }
  ComInit(const ComInit&) = delete;
  ComInit& operator=(const ComInit&) = delete;

 private:
  bool needs_uninit_;
};

static std::string FindAddressBarUrl(IUIAutomation* automation, IUIAutomationElement* root) {
  if (!automation || !root) {
    return {};
  }

  VARIANT varEdit;
  VariantInit(&varEdit);
  V_VT(&varEdit) = VT_I4;
  V_I4(&varEdit) = UIA_EditControlTypeId;

  IUIAutomationCondition* editCondition = nullptr;
  HRESULT hr = automation->CreatePropertyCondition(UIA_ControlTypePropertyId, varEdit, &editCondition);
  VariantClear(&varEdit);
  if (FAILED(hr) || !editCondition) {
    return {};
  }

  IUIAutomationElementArray* editElements = nullptr;
  hr = root->FindAll(TreeScope_Descendants, editCondition, &editElements);
  editCondition->Release();
  if (FAILED(hr) || !editElements) {
    return {};
  }

  INT count = 0;
  editElements->get_Length(&count);

  std::string best;
  for (INT i = 0; i < count && best.empty(); ++i) {
    IUIAutomationElement* edit = nullptr;
    if (FAILED(editElements->GetElement(i, &edit)) || !edit) {
      continue;
    }

    IUIAutomationValuePattern* valuePattern = nullptr;
    hr = edit->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&valuePattern));
    if (SUCCEEDED(hr) && valuePattern) {
      BSTR bstrValue = nullptr;
      if (SUCCEEDED(valuePattern->get_CurrentValue(&bstrValue)) && bstrValue) {
        std::string raw = BstrToUtf8(bstrValue);
        SysFreeString(bstrValue);
        if (LooksLikeUrl(raw)) {
          best = NormalizeUrl(raw);
        }
      }
      valuePattern->Release();
    }
    edit->Release();
  }

  editElements->Release();
  return best;
}

Napi::Value GetBrowserUrl(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "HWND number is required").ThrowAsJavaScriptException();
    return env.Null();
  }

  HWND hwnd = reinterpret_cast<HWND>(info[0].As<Napi::Number>().Int64Value());
  if (!hwnd || !IsWindow(hwnd)) {
    return env.Null();
  }

  ComInit com;

  IUIAutomation* automation = nullptr;
  HRESULT hr = CoCreateInstance(
      CLSID_CUIAutomation,
      nullptr,
      CLSCTX_INPROC_SERVER,
      IID_IUIAutomation,
      reinterpret_cast<void**>(&automation));
  if (FAILED(hr) || !automation) {
    return env.Null();
  }

  IUIAutomationElement* root = nullptr;
  hr = automation->ElementFromHandle(hwnd, &root);
  if (FAILED(hr) || !root) {
    automation->Release();
    return env.Null();
  }

  std::string url = FindAddressBarUrl(automation, root);

  root->Release();
  automation->Release();

  if (url.empty()) {
    return env.Null();
  }
  return Napi::String::New(env, url);
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getBrowserUrl", Napi::Function::New(env, GetBrowserUrl));
  return exports;
}

NODE_API_MODULE(win_browser_url, Init)
