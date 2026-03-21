import Foundation

struct StationSelectionStore {
    private let userDefaults: UserDefaults
    private let selectedStationKey = "og.capture.selectedStation"

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }

    func loadSelectedStation() -> CaptureStation? {
        guard let data = userDefaults.data(forKey: selectedStationKey) else {
            return nil
        }

        return try? JSONDecoder().decode(CaptureStation.self, from: data)
    }

    func saveSelectedStation(_ station: CaptureStation) {
        guard let data = try? JSONEncoder().encode(station) else {
            return
        }

        userDefaults.set(data, forKey: selectedStationKey)
    }

    func clearSelectedStation() {
        userDefaults.removeObject(forKey: selectedStationKey)
    }
}
