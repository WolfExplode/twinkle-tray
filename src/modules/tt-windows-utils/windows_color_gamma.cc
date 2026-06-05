#include <napi.h>
#include <windows.h>
#include <algorithm>
#include <string>
#include <vector>

struct MonitorInfo {
  std::string deviceName;
  RECT rect;
};

static std::vector<MonitorInfo> sortedMonitors;

static BOOL CALLBACK MonitorEnumProc(HMONITOR hMonitor, HDC, LPRECT, LPARAM) {
  MONITORINFOEX miex;
  miex.cbSize = sizeof(MONITORINFOEX);
  if (!GetMonitorInfo(hMonitor, &miex)) return TRUE;

  MonitorInfo info;
  info.deviceName = std::string(miex.szDevice);
  info.rect = miex.rcMonitor;
  sortedMonitors.push_back(info);
  return TRUE;
}

static void refreshSortedMonitors() {
  sortedMonitors.clear();
  EnumDisplayMonitors(NULL, NULL, MonitorEnumProc, 0);
  std::sort(sortedMonitors.begin(), sortedMonitors.end(), [](const MonitorInfo& a, const MonitorInfo& b) {
    if (a.rect.left != b.rect.left) return a.rect.left < b.rect.left;
    return a.rect.top < b.rect.top;
  });
}

static HDC getDisplayDC(int index) {
  if (sortedMonitors.empty()) refreshSortedMonitors();
  if (index < 0 || index >= (int)sortedMonitors.size()) return NULL;
  return CreateDC(NULL, sortedMonitors[index].deviceName.c_str(), NULL, NULL);
}

static bool applyGammaRamp(HDC hdc, double r, double g, double b) {
  if (hdc == NULL) return false;

  r = std::max(0.0, std::min(1.0, r));
  g = std::max(0.0, std::min(1.0, g));
  b = std::max(0.0, std::min(1.0, b));

  WORD ramp[3 * 256];
  WORD* rampR = &ramp[0];
  WORD* rampG = &ramp[256];
  WORD* rampB = &ramp[512];

  for (int i = 0; i < 256; i++) {
    double intensity = 65535.0 * i / 255.0;
    rampR[i] = (WORD)std::min(65535.0, intensity * r);
    rampG[i] = (WORD)std::min(65535.0, intensity * g);
    rampB[i] = (WORD)std::min(65535.0, intensity * b);
  }

  return SetDeviceGammaRamp(hdc, ramp) != 0;
}

static Napi::Number GetDisplayCount(const Napi::CallbackInfo& info) {
  refreshSortedMonitors();
  return Napi::Number::New(info.Env(), sortedMonitors.size());
}

static Napi::Boolean SetGammaRamp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 4) {
    Napi::TypeError::New(env, "Expected displayIndex, r, g, b").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  int index = info[0].As<Napi::Number>().Int32Value();
  double r = info[1].As<Napi::Number>().DoubleValue();
  double g = info[2].As<Napi::Number>().DoubleValue();
  double b = info[3].As<Napi::Number>().DoubleValue();

  HDC hdc = getDisplayDC(index);
  if (hdc == NULL) return Napi::Boolean::New(env, false);

  bool ok = applyGammaRamp(hdc, r, g, b);
  DeleteDC(hdc);
  return Napi::Boolean::New(env, ok);
}

static Napi::Boolean ResetGammaRamp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1) {
    Napi::TypeError::New(env, "Expected displayIndex").ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  int index = info[0].As<Napi::Number>().Int32Value();
  HDC hdc = getDisplayDC(index);
  if (hdc == NULL) return Napi::Boolean::New(env, false);

  bool ok = applyGammaRamp(hdc, 1.0, 1.0, 1.0);
  DeleteDC(hdc);
  return Napi::Boolean::New(env, ok);
}

static Napi::Boolean ResetAllGammaRamps(const Napi::CallbackInfo& info) {
  refreshSortedMonitors();
  bool ok = true;
  for (int i = 0; i < (int)sortedMonitors.size(); i++) {
    HDC hdc = getDisplayDC(i);
    if (hdc == NULL) {
      ok = false;
      continue;
    }
    if (!applyGammaRamp(hdc, 1.0, 1.0, 1.0)) ok = false;
    DeleteDC(hdc);
  }
  return Napi::Boolean::New(info.Env(), ok);
}

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("getDisplayCount", Napi::Function::New(env, GetDisplayCount));
  exports.Set("setGammaRamp", Napi::Function::New(env, SetGammaRamp));
  exports.Set("resetGammaRamp", Napi::Function::New(env, ResetGammaRamp));
  exports.Set("resetAllGammaRamps", Napi::Function::New(env, ResetAllGammaRamps));
  return exports;
}

NODE_API_MODULE(windows_color_gamma, Init)
