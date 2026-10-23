using System.Text.Json;

namespace AACpipe.Ocr;

internal sealed record OcrProfile(string ProcessName, int Width, int Height, Rectangle[] Bands, string Language, string BridgePath)
{
    internal static string FilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AACpipe.Ocr", "profile.json");

    internal void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        var temporary = FilePath + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this));
        File.Move(temporary, FilePath, overwrite: true);
    }

    internal static OcrProfile? Load()
    {
        if (!File.Exists(FilePath)) return null;
        var profile = JsonSerializer.Deserialize<OcrProfile>(File.ReadAllText(FilePath))
            ?? throw new InvalidDataException("The OCR profile is empty.");
        var bounds = new Rectangle(0, 0, profile.Width, profile.Height);
        if (profile.Width < 1 || profile.Height < 1 || profile.Width > 8192 || profile.Height > 8192 ||
            profile.Bands is null || profile.Bands.Length is < 1 or > 12 ||
            profile.Bands.Any(band => band.Width < 8 || band.Height < 8 || !bounds.Contains(band)) ||
            profile.Bands.Where((band, index) => profile.Bands.Skip(index + 1).Any(band.IntersectsWith)).Any() ||
            string.IsNullOrWhiteSpace(profile.ProcessName) || string.IsNullOrWhiteSpace(profile.Language) ||
            string.IsNullOrWhiteSpace(profile.BridgePath))
            throw new InvalidDataException("The saved OCR profile is invalid. Select and save new text bands.");
        return profile;
    }
}
