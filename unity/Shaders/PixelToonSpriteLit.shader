// Dead Cells tarzı oyun içi ışık: URP 2D ışıkları sprite'ın normal map'iyle hesaplanır,
// sonra ışık şiddeti birkaç kademeye yuvarlanır (toon). Böylece karakter meşalenin yanından
// geçerken gölge gerçekten değişir ama yumuşak geçiş değil, pixel art bantları olarak görünür.
//
// Gereken: Unity 6 (URP 17+), 2D Renderer. Light 2D bileşeninde "Normal Maps" açık olmalı.
// Sprite, araçtan "Gölgeyi sprite'a göm" KAPALI olarak export edilmeli.
// Unity'nin kendi Sprite-Lit-Default shader'ı temel alınmıştır.

Shader "PixelSheet/Toon Sprite Lit"
{
    Properties
    {
        _MainTex("Diffuse", 2D) = "white" {}
        _MaskTex("Mask", 2D) = "white" {}
        _NormalMap("Normal Map", 2D) = "bump" {}
        _Steps("Ton kademesi", Range(1, 8)) = 3
        _MaxLight("Tam aydinlik isik siddeti", Range(0.1, 4)) = 1
        _MinLight("En koyu ton", Range(0, 1)) = 0.25
        _ShadowTint("Golge rengi", Color) = (0.62, 0.55, 0.85, 1)
        [MaterialToggle] _ZWrite("ZWrite", Float) = 0

        [HideInInspector] _Color("Tint", Color) = (1,1,1,1)
        [HideInInspector] _RendererColor("RendererColor", Color) = (1,1,1,1)
        [HideInInspector] _AlphaTex("External Alpha", 2D) = "white" {}
        [HideInInspector] _EnableExternalAlpha("Enable External Alpha", Float) = 0
    }

    SubShader
    {
        Tags { "Queue" = "Transparent" "RenderType" = "Transparent" "RenderPipeline" = "UniversalPipeline" }

        Blend SrcAlpha OneMinusSrcAlpha, One OneMinusSrcAlpha
        Cull Off
        ZWrite [_ZWrite]

        HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
        #include "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/Core2D.hlsl"

        // Bütün pass'lerde aynı düzen olmalı (SRP Batcher).
        CBUFFER_START(UnityPerMaterial)
            half4 _Color;
            float4 _MainTex_TexelSize;
            half4 _ShadowTint;
            half _Steps;
            half _MaxLight;
            half _MinLight;
        CBUFFER_END
        ENDHLSL

        // ---------- Renk + kademeli ışık ----------
        Pass
        {
            Tags { "LightMode" = "Universal2D" }

            HLSLPROGRAM
            #pragma vertex ToonVertex
            #pragma fragment ToonFragment
            #include_with_pragmas "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/ShapeLightShared.hlsl"
            #pragma multi_compile_instancing

            struct Attributes
            {
                float3 positionOS : POSITION;
                float4 color      : COLOR;
                float2 uv         : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                half4  color      : COLOR;
                float2 uv         : TEXCOORD0;
                float2 lightingUV : TEXCOORD1;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            #include "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/InputData2D.hlsl"
            #include "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/SurfaceData2D.hlsl"

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);
            TEXTURE2D(_MaskTex);
            SAMPLER(sampler_MaskTex);

            // Unity 6.3+ ışık dokularını kendi include'unda tanımlıyor (COMMON_2D_INPUTS o sürümle geldi);
            // daha eski Unity 6 sürümlerinde shader'ın tanımlaması gerekiyor.
            #ifndef COMMON_2D_INPUTS
                #include "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/LightingUtility.hlsl"
                #if USE_SHAPE_LIGHT_TYPE_0
                SHAPE_LIGHT(0)
                #endif
                #if USE_SHAPE_LIGHT_TYPE_1
                SHAPE_LIGHT(1)
                #endif
                #if USE_SHAPE_LIGHT_TYPE_2
                SHAPE_LIGHT(2)
                #endif
                #if USE_SHAPE_LIGHT_TYPE_3
                SHAPE_LIGHT(3)
                #endif
            #endif

            #include "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/CombinedShapeLightShared.hlsl"

            Varyings ToonVertex(Attributes v)
            {
                Varyings o = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);

                SetUpSpriteInstanceProperties();
                v.positionOS = UnityFlipSprite(v.positionOS, unity_SpriteProps.xy);
                o.positionCS = TransformObjectToHClip(v.positionOS);
                o.uv = v.uv;
                o.lightingUV = ComputeScreenPos(o.positionCS / o.positionCS.w).xy;
                o.color = v.color * _Color * unity_SpriteColor;
                return o;
            }

            half4 ToonFragment(Varyings i) : SV_Target
            {
                const half4 main = i.color * SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv);
                const half4 mask = SAMPLE_TEXTURE2D(_MaskTex, sampler_MaskTex, i.uv);

                // Işığı sprite pikselinin MERKEZİNDEN oku: ekran çözünürlüğü sprite'tan yüksek olsa bile
                // bir sprite pikselinin tamamı aynı tonda kalır, bant sınırı pikselin içinden geçmez.
                float2 texelCenter = (floor(i.uv * _MainTex_TexelSize.zw) + 0.5) * _MainTex_TexelSize.xy;
                float2 d = texelCenter - i.uv;
                float2 uvDx = ddx(i.uv);
                float2 uvDy = ddy(i.uv);
                float det = uvDx.x * uvDy.y - uvDx.y * uvDy.x;
                float2 lightingUV = i.lightingUV;
                if (abs(det) > 1e-12)
                {
                    float2 screenOffset = float2(d.x * uvDy.y - d.y * uvDy.x, uvDx.x * d.y - uvDx.y * d.x) / det;
                    lightingUV += ddx(i.lightingUV) * screenOffset.x + ddy(i.lightingUV) * screenOffset.y;
                }

                // Beyaz yüzeyle çağırınca dönen değer o pikseldeki toplam ışıktır.
                SurfaceData2D surfaceData;
                InputData2D inputData;
                InitializeSurfaceData(half3(1, 1, 1), main.a, mask, surfaceData);
                InitializeInputData(i.uv, (half2)lightingUV, inputData);
                const half3 light = CombinedShapeLightShared(surfaceData, inputData).rgb;

                const half intensity = max(light.r, max(light.g, light.b));
                const half3 lightHue = intensity > 1e-4 ? light / intensity : half3(1, 1, 1);
                const half steps = max(1, round(_Steps));
                const half level = saturate(intensity / _MaxLight);
                const half band = max(round(level * steps) / steps, _MinLight);

                half3 lit = lightHue * band * _MaxLight;
                lit *= lerp(_ShadowTint.rgb, half3(1, 1, 1), band); // koyu bantlar gölge rengine kayar

                return half4(main.rgb * lit, main.a);
            }
            ENDHLSL
        }

        // ---------- Normal map'i ışık sistemine verir ----------
        Pass
        {
            Tags { "LightMode" = "NormalsRendering" }

            HLSLPROGRAM
            #pragma vertex NormalsRenderingVertex
            #pragma fragment NormalsRenderingFragment
            #pragma multi_compile_instancing

            struct Attributes
            {
                float3 positionOS : POSITION;
                float4 color      : COLOR;
                float2 uv         : TEXCOORD0;
                float3 normal     : NORMAL;
                float4 tangent    : TANGENT;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS  : SV_POSITION;
                half4  color       : COLOR;
                float2 uv          : TEXCOORD0;
                half3  normalWS    : TEXCOORD1;
                half3  tangentWS   : TEXCOORD2;
                half3  bitangentWS : TEXCOORD3;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);
            TEXTURE2D(_NormalMap);
            SAMPLER(sampler_NormalMap);

            Varyings NormalsRenderingVertex(Attributes v)
            {
                Varyings o = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);

                SetUpSpriteInstanceProperties();
                v.positionOS = UnityFlipSprite(v.positionOS, unity_SpriteProps.xy);
                o.positionCS = TransformObjectToHClip(v.positionOS);
                o.uv = v.uv;
                o.color = v.color * _Color * unity_SpriteColor;
                o.normalWS = TransformObjectToWorldDir(v.normal);
                o.tangentWS = TransformObjectToWorldDir(v.tangent.xyz);
                o.bitangentWS = cross(o.normalWS, o.tangentWS) * v.tangent.w;
                return o;
            }

            #include "Packages/com.unity.render-pipelines.universal/Shaders/2D/Include/NormalsRenderingShared.hlsl"

            half4 NormalsRenderingFragment(Varyings i) : SV_Target
            {
                const half4 mainTex = i.color * SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv);
                const half3 normalTS = UnpackNormal(SAMPLE_TEXTURE2D(_NormalMap, sampler_NormalMap, i.uv));
                return NormalsRenderingShared(mainTex, normalTS, i.tangentWS.xyz, i.bitangentWS.xyz, i.normalWS.xyz);
            }
            ENDHLSL
        }

        // ---------- 2D Renderer dışında kullanılırsa: ışıksız ----------
        Pass
        {
            Tags { "LightMode" = "UniversalForward" "Queue" = "Transparent" "RenderType" = "Transparent" }

            HLSLPROGRAM
            #pragma vertex UnlitVertex
            #pragma fragment UnlitFragment
            #pragma multi_compile_instancing

            struct Attributes
            {
                float3 positionOS : POSITION;
                float4 color      : COLOR;
                float2 uv         : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float4 color      : COLOR;
                float2 uv         : TEXCOORD0;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            TEXTURE2D(_MainTex);
            SAMPLER(sampler_MainTex);

            Varyings UnlitVertex(Attributes v)
            {
                Varyings o = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);

                SetUpSpriteInstanceProperties();
                v.positionOS = UnityFlipSprite(v.positionOS, unity_SpriteProps.xy);
                o.positionCS = TransformObjectToHClip(v.positionOS);
                o.uv = v.uv;
                o.color = v.color * _Color * unity_SpriteColor;
                return o;
            }

            float4 UnlitFragment(Varyings i) : SV_Target
            {
                return i.color * SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv);
            }
            ENDHLSL
        }
    }

    Fallback "Sprites/Default"
}
