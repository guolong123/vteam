import { DEVICE_SPECS, type DeviceType } from "../prototypes/types";
import { IconMonitor, IconSmartphone } from "../prototypes/_shared/ui";

/**
 * DeviceSwitcher：设备切换器
 * =====================================================
 * PC / 移动端 segmented control，当前选中项高亮。
 */
interface DeviceSwitcherProps {
  device: DeviceType;
  onChange: (device: DeviceType) => void;
}

const deviceIcons: Record<DeviceType, typeof IconMonitor> = {
  desktop: IconMonitor,
  mobile: IconSmartphone,
};

export default function DeviceSwitcher({ device, onChange }: DeviceSwitcherProps) {
  const types: DeviceType[] = ["desktop", "mobile"];
  return (
    <div
      role="group"
      aria-label="设备切换"
      className="inline-flex items-center gap-1 rounded-[--radius-control] border border-slate-200 bg-slate-100/80 p-1"
    >
      {types.map((t) => {
        const Icon = deviceIcons[t];
        const active = t === device;
        return (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
              active
                ? "bg-white text-brand-700 shadow-panel"
                : "text-slate-500 hover:text-slate-800"
            }`}
          >
            <Icon className="size-4" />
            {DEVICE_SPECS[t].label}
          </button>
        );
      })}
    </div>
  );
}
