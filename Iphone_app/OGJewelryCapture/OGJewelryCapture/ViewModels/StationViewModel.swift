import Combine
import Foundation

@MainActor
final class StationViewModel: ObservableObject {
    @Published private(set) var stations: [CaptureStation] = []
    @Published private(set) var selectedStation: CaptureStation?
    @Published private(set) var isLoading = false
    @Published var errorMessage: String?

    private let stationRepository: StationRepository
    private let stationSelectionStore: StationSelectionStore
    private var hasBootstrapped = false

    init(
        stationRepository: StationRepository,
        stationSelectionStore: StationSelectionStore
    ) {
        self.stationRepository = stationRepository
        self.stationSelectionStore = stationSelectionStore
        self.selectedStation = stationSelectionStore.loadSelectedStation()
    }

    convenience init() {
        self.init(
            stationRepository: StationRepository(client: SupabaseService.shared),
            stationSelectionStore: StationSelectionStore(userDefaults: .standard)
        )
    }

    func bootstrap() async {
        guard !hasBootstrapped else { return }

        hasBootstrapped = true
        await refreshStations()
    }

    func refreshStations() async {
        isLoading = true
        errorMessage = nil

        defer { isLoading = false }

        do {
            let fetchedStations = try await stationRepository.fetchAvailableStations()
            stations = fetchedStations

            if let selectedStation {
                if let refreshedSelection = fetchedStations.first(where: { $0.id == selectedStation.id }) {
                    self.selectedStation = refreshedSelection
                    stationSelectionStore.saveSelectedStation(refreshedSelection)
                } else {
                    clearSelection()
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func selectStation(_ station: CaptureStation) {
        selectedStation = station
        stationSelectionStore.saveSelectedStation(station)
    }

    func clearSelection() {
        selectedStation = nil
        stationSelectionStore.clearSelectedStation()
    }
}
