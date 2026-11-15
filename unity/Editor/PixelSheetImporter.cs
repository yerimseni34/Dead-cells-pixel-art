// Pixel sprite aracının çıktısını (xxx.json + xxx_color.png + xxx_normal.png) Unity'ye alır:
//  - renk sheet'ini hücrelere böler, pivot'u modelin ayak noktasına koyar
//  - Point filtre / sıkıştırmasız / doğru PPU ayarlarını yapar
//  - normal sheet'i "_NormalMap" ikincil dokusu olarak bağlar (URP 2D ışıkları bunu kullanır)
//  - her animasyon için bir AnimationClip üretir
//
// Kurulum: bu dosyayı projende Assets/Editor/ altına kopyala. Gereken: Unity 2021.3+, "2D Sprite" paketi.
// Kullanım: üç dosyayı aynı klasöre at, .json dosyasına sağ tıkla > Pixel Sheet > Import.

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.U2D.Sprites;
using UnityEngine;

public static class PixelSheetImporter
{
    [Serializable] class Pivot { public float x; public float y; }
    [Serializable] class ClipInfo { public string name; public int start; public int count; public float fps; public bool loop; }
    [Serializable]
    class Meta
    {
        public string name;
        public string colorTexture;
        public string normalTexture;
        public int cellWidth;
        public int cellHeight;
        public int columns;
        public int rows;
        public int frameCount;
        public Pivot pivot;
        public float pixelsPerUnit;
        public bool shadingBaked;
        public ClipInfo[] clips;
    }

    const string MenuPath = "Assets/Pixel Sheet/Import";

    [MenuItem(MenuPath, true)]
    static bool Validate()
    {
        var path = AssetDatabase.GetAssetPath(Selection.activeObject);
        return !string.IsNullOrEmpty(path) && path.EndsWith(".json", StringComparison.OrdinalIgnoreCase);
    }

    [MenuItem(MenuPath)]
    static void ImportSelected()
    {
        Import(AssetDatabase.GetAssetPath(Selection.activeObject));
    }

    public static void Import(string jsonPath)
    {
        var meta = JsonUtility.FromJson<Meta>(File.ReadAllText(jsonPath));
        if (meta == null || meta.cellWidth <= 0 || meta.cellHeight <= 0 || meta.frameCount <= 0)
        {
            Debug.LogError($"Pixel Sheet: '{jsonPath}' geçerli bir sheet JSON'u değil.");
            return;
        }

        var dir = Path.GetDirectoryName(jsonPath).Replace('\\', '/');
        var colorPath = dir + "/" + meta.colorTexture;
        var normalPath = dir + "/" + meta.normalTexture;

        var colorImporter = AssetImporter.GetAtPath(colorPath) as TextureImporter;
        if (colorImporter == null)
        {
            Debug.LogError($"Pixel Sheet: renk dokusu bulunamadı: {colorPath}");
            return;
        }

        // --- Normal map dokusu ---
        Texture2D normalTexture = null;
        var normalImporter = AssetImporter.GetAtPath(normalPath) as TextureImporter;
        if (normalImporter != null)
        {
            normalImporter.textureType = TextureImporterType.NormalMap;
            ApplyPixelSettings(normalImporter);
            normalImporter.SaveAndReimport();
            normalTexture = AssetDatabase.LoadAssetAtPath<Texture2D>(normalPath);
        }
        else
        {
            Debug.LogWarning($"Pixel Sheet: normal dokusu yok, atlanıyor: {normalPath}");
        }

        // --- Renk dokusu: önce importer ayarları (Multiple moda geçmeden sprite verisi yazılamaz) ---
        colorImporter.textureType = TextureImporterType.Sprite;
        colorImporter.spriteImportMode = SpriteImportMode.Multiple;
        colorImporter.spritePixelsPerUnit = meta.pixelsPerUnit > 0 ? meta.pixelsPerUnit : 32;
        colorImporter.alphaIsTransparency = true;
        ApplyPixelSettings(colorImporter);
        colorImporter.SaveAndReimport();

        // --- Sprite dikdörtgenleri ---
        var factory = new SpriteDataProviderFactories();
        factory.Init();
        var dataProvider = factory.GetSpriteEditorDataProviderFromObject(colorImporter);
        dataProvider.InitSpriteEditorDataProvider();

        // Aynı isimli eski sprite'ların kimliğini koru: yeniden import edince sahnedeki referanslar kopmasın.
        var existing = dataProvider.GetSpriteRects().ToDictionary(r => r.name, r => r.spriteID);
        int sheetHeight = meta.rows * meta.cellHeight;
        var normalizedPivot = new Vector2(meta.pivot.x / meta.cellWidth, meta.pivot.y / meta.cellHeight);

        var rects = new List<SpriteRect>();
        for (int i = 0; i < meta.frameCount; i++)
        {
            int col = i % meta.columns;
            int row = i / meta.columns;
            string spriteName = $"{meta.name}_{i:000}";
            rects.Add(new SpriteRect
            {
                name = spriteName,
                spriteID = existing.TryGetValue(spriteName, out var id) ? id : GUID.Generate(),
                // JSON'da satırlar yukarıdan aşağı; Unity'de doku orijini sol-alt.
                rect = new Rect(col * meta.cellWidth, sheetHeight - (row + 1) * meta.cellHeight, meta.cellWidth, meta.cellHeight),
                alignment = SpriteAlignment.Custom,
                pivot = normalizedPivot,
            });
        }
        dataProvider.SetSpriteRects(rects.ToArray());

        var nameFileIds = dataProvider.GetDataProvider<ISpriteNameFileIdDataProvider>();
        if (nameFileIds != null)
        {
            nameFileIds.SetNameFileIdPairs(rects.Select(r => new SpriteNameFileIdPair(r.name, r.spriteID)).ToList());
        }

        if (normalTexture != null)
        {
            var secondary = dataProvider.GetDataProvider<ISecondaryTextureDataProvider>();
            if (secondary != null)
            {
                secondary.textures = new[] { new SecondarySpriteTexture { name = "_NormalMap", texture = normalTexture } };
            }
        }

        dataProvider.Apply();
        colorImporter.SaveAndReimport();

        // --- Animasyon klipleri ---
        var sprites = AssetDatabase.LoadAllAssetsAtPath(colorPath).OfType<Sprite>().ToDictionary(s => s.name, s => s);
        int created = 0;
        foreach (var info in meta.clips ?? Array.Empty<ClipInfo>())
        {
            if (info.count <= 0 || info.fps <= 0) continue;
            var keys = new List<ObjectReferenceKeyframe>();
            for (int i = 0; i < info.count; i++)
            {
                if (!sprites.TryGetValue($"{meta.name}_{info.start + i:000}", out var sprite)) continue;
                keys.Add(new ObjectReferenceKeyframe { time = i / info.fps, value = sprite });
            }
            if (keys.Count == 0) continue;
            // Son frame de diğerleri kadar ekranda kalsın diye kapanış anahtarı
            keys.Add(new ObjectReferenceKeyframe { time = info.count / info.fps, value = keys[keys.Count - 1].value });

            string clipPath = $"{dir}/{meta.name}_{info.name}.anim";
            var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(clipPath);
            bool isNew = clip == null;
            if (isNew) clip = new AnimationClip();
            else clip.ClearCurves();

            clip.frameRate = info.fps;
            var binding = EditorCurveBinding.PPtrCurve(string.Empty, typeof(SpriteRenderer), "m_Sprite");
            AnimationUtility.SetObjectReferenceCurve(clip, binding, keys.ToArray());
            var settings = AnimationUtility.GetAnimationClipSettings(clip);
            settings.loopTime = info.loop;
            AnimationUtility.SetAnimationClipSettings(clip, settings);

            if (isNew) AssetDatabase.CreateAsset(clip, clipPath);
            else EditorUtility.SetDirty(clip);
            created++;
        }

        // --- Gölge sprite'a gömülmediyse: kademeli ışık materyali ---
        string materialNote = string.Empty;
        if (!meta.shadingBaked)
        {
            var toonShader = Shader.Find("PixelSheet/Toon Sprite Lit");
            string materialPath = $"{dir}/{meta.name}_toon.mat";
            if (toonShader == null)
            {
                Debug.LogWarning("Pixel Sheet: 'PixelSheet/Toon Sprite Lit' shader'ı projede yok; PixelToonSpriteLit.shader dosyasını Assets altına kopyala.");
            }
            else if (AssetDatabase.LoadAssetAtPath<Material>(materialPath) == null)
            {
                AssetDatabase.CreateAsset(new Material(toonShader), materialPath);
                materialNote = $" SpriteRenderer'a '{meta.name}_toon' materyalini ata.";
            }
        }

        AssetDatabase.SaveAssets();
        Debug.Log($"Pixel Sheet: '{meta.name}' içe aktarıldı ({rects.Count} sprite, {created} animasyon klibi).{materialNote}");
    }

    static void ApplyPixelSettings(TextureImporter importer)
    {
        importer.filterMode = FilterMode.Point;
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        importer.mipmapEnabled = false;
        importer.wrapMode = TextureWrapMode.Clamp;
        importer.npotScale = TextureImporterNPOTScale.None;
        importer.maxTextureSize = 8192;
    }
}
